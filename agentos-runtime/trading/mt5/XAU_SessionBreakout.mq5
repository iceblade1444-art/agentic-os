//+------------------------------------------------------------------+
//|                                          XAU_SessionBreakout.mq5 |
//|  Gold session range breakout, long and short, for MetaTrader 5.  |
//|                                                                  |
//|  Same rules as trader-gold/gold.py (the backtester):             |
//|   London ORB : first N min after 08:00 London time               |
//|   New York ORB: first N min after 08:30 New York time            |
//|   Asia->London: 00:00-07:00 London range, break from 07:00       |
//|  Entry: first closed M5 bar beyond the range (one per session,   |
//|  first side to break decides). Stop: range mid or opposite side. |
//|  Target: R multiple. Flat at the session's flat time.            |
//|  Risk: % of balance per trade, daily loss limit, trades per day. |
//|                                                                  |
//|  Education and tooling, not financial advice. Test on a demo.    |
//+------------------------------------------------------------------+
#property copyright   "trader-gold, day-trader-skill pack"
#property version     "2.10"
#property description "Gold (XAUUSD) session range breakout: London ORB, New York ORB, Asian range -> London break."
#property description "Long and short. Risk-based lots, daily loss limit, max trades per day, flat by session end."
#property description "v2: built-in time machine (10,000 replays per signal) and high-impact news filter."

#include <Trade\Trade.mqh>

//--- enums -----------------------------------------------------------
enum ENUM_SESSION_MODE
  {
   SESSION_LONDON      = 0,   // London opening range
   SESSION_NEWYORK     = 1,   // New York opening range
   SESSION_ASIA_LONDON = 2,   // Asian range -> London break
   SESSION_ALL         = 3    // All three
  };
enum ENUM_STOP_MODE
  {
   STOP_RANGE_MID      = 0,   // Range midpoint
   STOP_RANGE_OPPOSITE = 1    // Opposite side of the range
  };
enum ENUM_SERVER_TZ
  {
   TZ_AUTO       = 0,         // Auto (live clock; DST rule in tester)
   TZ_EET_US_DST = 1,         // UTC+2 / UTC+3 with US DST (most brokers)
   TZ_FIXED      = 2,         // Fixed offset (below), no DST
   TZ_EU_DST     = 3          // Offset below + 1h in EU/UK summer time
  };
enum ENUM_RUN_MODE
  {
   MODE_AUTO_TRADE   = 0,     // Trade automatically
   MODE_SIGNALS_ONLY = 1      // Signals only: push to phone, no orders
  };
enum ENUM_TM_MODE
  {
   TM_OFF  = 0,               // Off
   TM_INFO = 1,               // Report only (push the odds, trade anyway)
   TM_GATE = 2                // Trade only with enough edge
  };
enum ENUM_RISK_MODE
  {
   RISK_PERCENT   = 0,        // % of balance per trade
   RISK_FIXED_LOT = 1         // Fixed lot size
  };

//--- inputs ----------------------------------------------------------
input group "Mode and phone"
input ENUM_RUN_MODE     InpMode          = MODE_AUTO_TRADE; // Mode
input bool              InpPush          = true;            // Push notifications to the MT5 phone app
input bool              InpPushSkipped   = false;           // Also push skipped signals

input group "Strategy"
input ENUM_SESSION_MODE InpSession       = SESSION_LONDON; // Session
input int               InpRangeMinutes  = 30;             // Opening range, minutes (London / NY)
input ENUM_STOP_MODE    InpStopMode      = STOP_RANGE_MID; // Stop placement
input double            InpTargetR       = 2.0;            // Target, multiples of risk (R)
input bool              InpAllowLong     = true;           // Allow buys
input bool              InpAllowShort    = true;           // Allow sells
input double            InpMinRangeUSD   = 1.0;            // Skip range smaller than (price)
input double            InpMaxRangeUSD   = 40.0;           // Skip range larger than (price)

input group "Session times (local city time, HH:MM)"
input string InpLondonOpen     = "08:00";  // London ORB start (London)
input string InpLondonEntryEnd = "12:00";  // London: no new entries after (London)
input string InpLondonFlat     = "16:00";  // London: flat by (London)
input string InpNYOpen         = "08:30";  // NY ORB start (New York)
input string InpNYEntryEnd     = "11:30";  // NY: no new entries after (New York)
input string InpNYFlat         = "16:00";  // NY: flat by (New York)
input string InpAsiaStart      = "00:00";  // Asian range start (London)
input string InpAsiaEnd        = "07:00";  // Asian range end = break window start (London)
input string InpAsiaEntryEnd   = "11:00";  // Asia: no new entries after (London)
input string InpAsiaFlat       = "16:00";  // Asia: flat by (London)

input group "Risk"
input ENUM_RISK_MODE InpRiskMode          = RISK_PERCENT; // Position sizing
input double         InpRiskPercent       = 0.5;          // Risk per trade, % of balance
input double         InpFixedLot          = 0.01;         // Fixed lot (if fixed sizing)
input double         InpDailyLossPercent  = 1.5;          // Daily loss limit, % (realized + open risk)
input int            InpMaxTradesPerDay   = 3;            // Max new trades per server day
input double         InpMaxSpreadUSD      = 0.50;         // Skip entry if spread above (price)
input double         InpMinSpreadUSD      = 0.15;         // Spread floor for the stop-too-tight rule (as backtest)
input double         InpMinStopSpreadMult = 3.0;          // Stop must be >= this x spread

input group "Time machine and news filter"
input ENUM_TM_MODE   InpTMMode            = TM_GATE;      // Time machine
input double         InpTMMinEdge         = 5.0;          // Min edge over break-even, percentage points
input int            InpTMReplays         = 10000;        // Replays per signal
input int            InpTMDays            = 60;           // Past days in the pool
input int            InpTMWindow          = 2;            // Same time of day +/- this many M5 bars
input uint           InpTMSeed            = 19;           // Random seed
input bool           InpNewsFilter        = true;         // Skip entries around high-impact news
input string         InpNewsCurrency      = "USD";        // News currency
input int            InpNewsBefore        = 30;           // Minutes before the news
input int            InpNewsAfter         = 30;           // Minutes after the news
input bool           InpNewsFailOpen      = false;        // If the calendar fails: trade anyway (true) or skip (false)

input group "Server bridge (Hermes / scripts)"
input bool           InpBridge            = true;         // Status/events/control files in Common\Files\xau_bridge
input int            InpBridgeExportBars  = 60000;        // Daily M5 export for analysis (0 = off)
input bool           InpBridgeMayEnable   = false;        // Bridge may switch ON auto trading / other sessions

input group "Broker / technical"
input ENUM_SERVER_TZ InpServerTZ          = TZ_AUTO;      // Broker server time zone
input int            InpFixedServerOffset = 2;            // Fixed / EU-DST base offset, hours from UTC
input long           InpMagic             = 20261027;     // Magic number (uses magic, +1, +2)
input int            InpSlippagePoints    = 30;           // Max slippage, points
input bool           InpShowPanel         = true;         // Show status on chart

//--- session state ---------------------------------------------------
#define S_LONDON 0
#define S_NY     1
#define S_ASIA   2

struct SessionState
  {
   bool     enabled;
   datetime dayKey;       // local calendar day (midnight) this state is for
   datetime rangeStart;   // server time
   datetime rangeEnd;
   datetime entryEnd;
   datetime flatTime;
   bool     rangeReady;
   double   hi;
   double   lo;
   bool     done;         // break seen (traded or not), window over, or range invalid
   string   status;
   int      offsetUsed;   // server-UTC offset (sec) the windows were computed with
   bool     signalSent;   // signals-only mode: a signal went out this session day
   bool     flatReminded; // signals-only mode: flat-time reminder sent
  };

SessionState g_s[3];
CTrade       g_trade;
datetime     g_lastBar = 0;
int          g_autoOffsetSec = 0;
bool         g_autoOk = false;
int          g_mLondonOpen, g_mLondonEntryEnd, g_mLondonFlat;
int          g_mNYOpen, g_mNYEntryEnd, g_mNYFlat;
int          g_mAsiaStart, g_mAsiaEnd, g_mAsiaEntryEnd, g_mAsiaFlat;
string       g_lastMsg = "";
datetime     g_lastFailMsg = 0;
bool         g_hedging = true;
datetime     g_limitPushedDay = 0;

void ComputeWindows(const int sid, const datetime day);

//--- runtime settings (inputs, possibly changed by the bridge's control file)
#define BR_ROOT "xau_bridge"
string g_brDir = "xau_bridge";                       // xau_bridge\<login>_<symbol>, set in OnInit
#define BR_DIR g_brDir
ENUM_RUN_MODE g_mode     = MODE_AUTO_TRADE;
double        g_riskPct  = 0.5;
bool          g_paused   = false;
string        g_sessOverride = "default";
long          g_ctrlSeq  = -1;
long          g_ctrlMtime = 0;
datetime      g_statusAt = 0;
datetime      g_exportDay = 0;
string        g_newsTodayJson = "[]";
datetime      g_newsTodayAt = 0;
string        g_lastExport = "";



//+------------------------------------------------------------------+
//| time helpers                                                     |
//+------------------------------------------------------------------+
datetime MakeDT(const int y, const int m, const int d, const int hh = 0, const int mi = 0)
  {
   MqlDateTime t;
   ZeroMemory(t);
   t.year = y; t.mon = m; t.day = d; t.hour = hh; t.min = mi; t.sec = 0;
   return StructToTime(t);
  }

int DayOfWeek(const datetime t)
  {
   MqlDateTime s;
   TimeToStruct(t, s);
   return s.day_of_week;           // 0 = Sunday
  }

datetime DayStart(const datetime t)
  {
   MqlDateTime s;
   TimeToStruct(t, s);
   return MakeDT(s.year, s.mon, s.day);
  }

datetime NthSunday(const int y, const int m, const int n)
  {
   int dow   = DayOfWeek(MakeDT(y, m, 1));
   int first = 1 + (7 - dow) % 7;
   return MakeDT(y, m, first + 7 * (n - 1));
  }

datetime LastSunday31(const int y, const int m)   // March / October
  {
   int dow = DayOfWeek(MakeDT(y, m, 31));
   return MakeDT(y, m, 31 - dow);
  }

int      g_usYear = 0;
datetime g_usSt = 0, g_usEn = 0;
bool IsUSDST(const datetime utc)
  {
   MqlDateTime s;
   TimeToStruct(utc, s);
   if(s.year != g_usYear)
     {
      g_usYear = s.year;
      g_usSt = NthSunday(s.year, 3, 2) + 7 * 3600;    // 02:00 EST
      g_usEn = NthSunday(s.year, 11, 1) + 6 * 3600;   // 02:00 EDT
     }
   return (utc >= g_usSt && utc < g_usEn);
  }

int      g_ukYear = 0;
datetime g_ukSt = 0, g_ukEn = 0;
bool IsUKDST(const datetime utc)
  {
   MqlDateTime s;
   TimeToStruct(utc, s);
   if(s.year != g_ukYear)
     {
      g_ukYear = s.year;
      g_ukSt = LastSunday31(s.year, 3) + 3600;        // 01:00 UTC
      g_ukEn = LastSunday31(s.year, 10) + 3600;
     }
   return (utc >= g_ukSt && utc < g_ukEn);
  }

datetime UTCToLondon(const datetime u) { return IsUKDST(u) ? u + 3600 : u; }
datetime LondonToUTC(const datetime l) { return IsUKDST(l - 3600) ? l - 3600 : l; }
datetime UTCToNY(const datetime u)     { return IsUSDST(u) ? u - 4 * 3600 : u - 5 * 3600; }
datetime NYToUTC(const datetime l)     { return IsUSDST(l + 4 * 3600) ? l + 4 * 3600 : l + 5 * 3600; }

bool InTester()
  {
   return (MQLInfoInteger(MQL_TESTER) != 0 || MQLInfoInteger(MQL_OPTIMIZATION) != 0);
  }

void UpdateAutoOffset()
  {
   if(InpServerTZ != TZ_AUTO || InTester())
     {
      g_autoOk = false;
      return;
     }
   long d    = (long)(TimeTradeServer() - TimeGMT());
   long half = 1800;
   long r    = (long)MathRound((double)d / (double)half) * half;
   if(MathAbs((double)r) > 14 * 3600 || MathAbs((double)(d - r)) > 300)
     {
      g_autoOk = false;       // PC clock off by > 5 min or nonsense: fall back to the DST rule
      return;
     }
   g_autoOffsetSec = (int)r;
   g_autoOk        = true;
  }

int EUOffsetAt(const datetime utc) { return InpFixedServerOffset * 3600 + (IsUKDST(utc) ? 3600 : 0); }

datetime ServerToUTC(const datetime s)
  {
   if(InpServerTZ == TZ_FIXED)
      return s - InpFixedServerOffset * 3600;
   if(InpServerTZ == TZ_EU_DST)
      return IsUKDST(s - (InpFixedServerOffset + 1) * 3600) ? s - (InpFixedServerOffset + 1) * 3600 : s - InpFixedServerOffset * 3600;
   if(InpServerTZ == TZ_AUTO && g_autoOk)
      return s - g_autoOffsetSec;
   return IsUSDST(s - 2 * 3600) ? s - 3 * 3600 : s - 2 * 3600;
  }

datetime UTCToServer(const datetime u)
  {
   if(InpServerTZ == TZ_FIXED)
      return u + InpFixedServerOffset * 3600;
   if(InpServerTZ == TZ_EU_DST)
      return u + EUOffsetAt(u);
   if(InpServerTZ == TZ_AUTO && g_autoOk)
      return u + g_autoOffsetSec;
   return IsUSDST(u) ? u + 3 * 3600 : u + 2 * 3600;
  }

int OffsetNow(const datetime s) { return (int)(s - ServerToUTC(s)); }

// "HH:MM" -> minutes after midnight, -1 if invalid
int ParseHM(const string s)
  {
   string parts[];
   if(StringSplit(s, ':', parts) != 2)
      return -1;
   int h = (int)StringToInteger(parts[0]);
   int m = (int)StringToInteger(parts[1]);
   if(h < 0 || h > 23 || m < 0 || m > 59)
      return -1;
   return h * 60 + m;
  }

//+------------------------------------------------------------------+
//| symbol / money helpers                                           |
//+------------------------------------------------------------------+
double NormPrice(const double p)
  {
   double tick = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tick <= 0)
      tick = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   return NormalizeDouble(MathRound(p / tick) * tick, (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS));
  }

int VolumeDigits()
  {
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   int d = 0;
   while(d < 8 && MathAbs(step - MathRound(step)) > 1e-9)
     {
      step *= 10.0;
      d++;
     }
   return d;
  }

bool IsOurMagic(const long m) { return (m >= InpMagic && m <= InpMagic + 2); }

// money lost if a position of `volume` goes from `open` to `stop`
double LossAt(const ENUM_ORDER_TYPE type, const double volume, const double open, const double stop)
  {
   double p = 0.0;
   if(!OrderCalcProfit(type, _Symbol, volume, open, stop, p))
      return -1.0;
   return MathMax(0.0, -p);
  }

// realized P/L and entries today (server day), for this EA's magics
bool TodayHistory(double &realized, int &entries, bool &sessionEntered[])
  {
   realized = 0.0;
   entries  = 0;
   for(int k = 0; k < 3; k++)
      sessionEntered[k] = false;
   datetime from = DayStart(TimeTradeServer());
   if(!HistorySelect(from, TimeTradeServer() + 3600))
      return false;                               // unknown history: callers must not trade
   long seen[];
   ArrayResize(seen, 0);
   int n = HistoryDealsTotal();
   for(int i = 0; i < n; i++)
     {
      ulong tk = HistoryDealGetTicket(i);
      if(tk == 0)
         continue;
      if(HistoryDealGetString(tk, DEAL_SYMBOL) != _Symbol)
         continue;
      long mg = HistoryDealGetInteger(tk, DEAL_MAGIC);
      if(!IsOurMagic(mg))
         continue;
      long entry = HistoryDealGetInteger(tk, DEAL_ENTRY);
      if(entry == DEAL_ENTRY_IN)
        {
         long pid = HistoryDealGetInteger(tk, DEAL_POSITION_ID);   // partial fills = one trade
         bool dup = false;
         for(int q = 0; q < ArraySize(seen); q++)
            if(seen[q] == pid) { dup = true; break; }
         if(!dup)
           {
            int sz = ArraySize(seen);
            ArrayResize(seen, sz + 1);
            seen[sz] = pid;
            entries++;
           }
         int sid = (int)(mg - InpMagic);
         datetime dt = (datetime)HistoryDealGetInteger(tk, DEAL_TIME);
         if(sid >= 0 && sid < 3 && dt >= g_s[sid].rangeStart)
            sessionEntered[sid] = true;
        }
      realized += HistoryDealGetDouble(tk, DEAL_PROFIT)
                + HistoryDealGetDouble(tk, DEAL_SWAP)
                + HistoryDealGetDouble(tk, DEAL_COMMISSION)
                + HistoryDealGetDouble(tk, DEAL_FEE);
     }
   // a restart must not forget today's entries even if history is still syncing
   string gv = "XAUSB_" + _Symbol + "_" + IntegerToString(InpMagic) + "_" + TimeToString(from, TIME_DATE) + "_entries";
   if(!InTester() && GlobalVariableCheck(gv))
      entries = (int)MathMax((double)entries, GlobalVariableGet(gv));
   return true;
  }

void RememberEntry()
  {
   if(InTester())
      return;
   string gv = "XAUSB_" + _Symbol + "_" + IntegerToString(InpMagic) + "_" + TimeToString(DayStart(TimeTradeServer()), TIME_DATE) + "_entries";
   double v = GlobalVariableCheck(gv) ? GlobalVariableGet(gv) : 0.0;
   GlobalVariableSet(gv, v + 1.0);
   GlobalVariablesFlush();
  }

// money at risk in this EA's open positions (to their stops)
double OpenRisk(bool &missingStop)
  {
   missingStop = false;
   double risk = 0.0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol || !IsOurMagic(PositionGetInteger(POSITION_MAGIC)))
         continue;
      double sl  = PositionGetDouble(POSITION_SL);
      double op  = PositionGetDouble(POSITION_PRICE_OPEN);
      double vol = PositionGetDouble(POSITION_VOLUME);
      ENUM_ORDER_TYPE t = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
      if(sl <= 0)
        {
         missingStop = true;
         continue;
        }
      double l = LossAt(t, vol, op, sl);
      if(l < 0)
         missingStop = true;
      else
         risk += l;
     }
   return risk;
  }

bool HasPosition(const int sid)
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == InpMagic + sid)
         return true;
     }
   return false;
  }

//+------------------------------------------------------------------+
//| sessions                                                         |
//+------------------------------------------------------------------+
string SessionName(const int sid)
  {
   if(sid == S_LONDON) return "London ORB";
   if(sid == S_NY)     return "New York ORB";
   return "Asia->London";
  }

// compute today's windows for a session; resets state on a new local day
void RefreshSession(const int sid, const datetime nowServer)
  {
   datetime utc = ServerToUTC(nowServer);
   datetime local = (sid == S_NY) ? UTCToNY(utc) : UTCToLondon(utc);
   datetime day = DayStart(local);
   int off = OffsetNow(nowServer);
   if(day == g_s[sid].dayKey && off == g_s[sid].offsetUsed)
      return;
   bool sameDay = (day == g_s[sid].dayKey);
   g_s[sid].offsetUsed = off;
   if(sameDay)
     {
      // the broker clock offset changed mid-day (DST switch or a clock fix): recompute windows, keep 'done'
      bool wasDone = g_s[sid].done;
      ComputeWindows(sid, day);
      g_s[sid].rangeReady = false;
      g_s[sid].done = wasDone;
      Print(SessionName(sid), ": server clock offset changed to UTC", (off >= 0 ? "+" : ""),
            DoubleToString(off / 3600.0, 1), ", session times recomputed");
      return;
     }

   g_s[sid].dayKey     = day;
   g_s[sid].rangeReady = false;
   g_s[sid].hi         = 0;
   g_s[sid].lo         = 0;
   g_s[sid].done       = false;
   g_s[sid].status     = "waiting for range";
   g_s[sid].signalSent   = false;
   g_s[sid].flatReminded = false;

   ComputeWindows(sid, day);
   int dow = DayOfWeek(day);
   if(dow == 0 || dow == 6)
     {
      g_s[sid].done   = true;
      g_s[sid].status = "weekend";
     }
  }

void WindowsFor(const int sid, const datetime day, const bool hist,
                datetime &rs, datetime &re, datetime &ee, datetime &fl)
  {
   datetime a, b, c, d;
   if(sid == S_LONDON)
     {
      a = LondonToUTC(day + g_mLondonOpen * 60);
      b = LondonToUTC(day + (g_mLondonOpen + InpRangeMinutes) * 60);
      c = LondonToUTC(day + g_mLondonEntryEnd * 60);
      d = LondonToUTC(day + g_mLondonFlat * 60);
     }
   else if(sid == S_NY)
     {
      a = NYToUTC(day + g_mNYOpen * 60);
      b = NYToUTC(day + (g_mNYOpen + InpRangeMinutes) * 60);
      c = NYToUTC(day + g_mNYEntryEnd * 60);
      d = NYToUTC(day + g_mNYFlat * 60);
     }
   else
     {
      a = LondonToUTC(day + g_mAsiaStart * 60);
      b = LondonToUTC(day + g_mAsiaEnd * 60);
      c = LondonToUTC(day + g_mAsiaEntryEnd * 60);
      d = LondonToUTC(day + g_mAsiaFlat * 60);
     }
   if(hist)
     {
      rs = HistUTCToServer(a); re = HistUTCToServer(b); ee = HistUTCToServer(c); fl = HistUTCToServer(d);
     }
   else
     {
      rs = UTCToServer(a); re = UTCToServer(b); ee = UTCToServer(c); fl = UTCToServer(d);
     }
  }

void ComputeWindows(const int sid, const datetime day)
  {
   datetime rs, re, ee, fl;
   WindowsFor(sid, day, false, rs, re, ee, fl);
   g_s[sid].rangeStart = rs;
   g_s[sid].rangeEnd   = re;
   g_s[sid].entryEnd   = ee;
   g_s[sid].flatTime   = fl;
  }

bool BuildRange(const int sid)
  {
   MqlRates r[];
   ArraySetAsSeries(r, false);
   int n = CopyRates(_Symbol, PERIOD_M5, g_s[sid].rangeStart, (datetime)(g_s[sid].rangeEnd - 1), r);
   double expected = (double)(g_s[sid].rangeEnd - g_s[sid].rangeStart) / 300.0;
   if(n < 0)
     {
      g_s[sid].status = StringFormat("loading M5 history (error %d), retrying next bar", GetLastError());
      return false;                               // not done: try again on the next bar
     }
   int need = (int)MathMax(1.0, MathFloor(expected * 0.6));
   if(n < need)
     {
      g_s[sid].done   = true;
      g_s[sid].status = StringFormat("range skipped: %d of %d bars", n, (int)expected);
      return false;
     }
   double hi = r[0].high, lo = r[0].low;
   for(int i = 1; i < n; i++)
     {
      if(r[i].high > hi) hi = r[i].high;
      if(r[i].low  < lo) lo = r[i].low;
     }
   g_s[sid].hi = hi;
   g_s[sid].lo = lo;
   g_s[sid].rangeReady = true;
   double w = hi - lo;
   if(w < InpMinRangeUSD || w > InpMaxRangeUSD)
     {
      g_s[sid].done   = true;
      g_s[sid].status = StringFormat("range %.2f outside %.2f-%.2f: skipped", w, InpMinRangeUSD, InpMaxRangeUSD);
      return false;
     }
   g_s[sid].status = StringFormat("range %.2f - %.2f (%.2f), watching", lo, hi, w);
   return true;
  }

// on a new M5 bar: look for the first closed bar beyond the range.
// returns +1 buy / -1 sell signal on the bar that just closed, 0 otherwise
int CheckBreak(const int sid)
  {
   datetime lastClosed = iTime(_Symbol, PERIOD_M5, 1);    // the bar that just closed (handles gaps)
   if(lastClosed == 0 || lastClosed < g_s[sid].rangeEnd)
      return 0;
   datetime lastAllowed = (datetime)(g_s[sid].entryEnd - 1);
   datetime to = (lastClosed < lastAllowed) ? lastClosed : lastAllowed;
   MqlRates r[];
   ArraySetAsSeries(r, false);
   int n = CopyRates(_Symbol, PERIOD_M5, g_s[sid].rangeEnd, to, r);
   if(n <= 0)
      return 0;
   for(int i = 0; i < n; i++)
     {
      int dir = 0;
      if(r[i].close > g_s[sid].hi)      dir = +1;
      else if(r[i].close < g_s[sid].lo) dir = -1;
      if(dir == 0)
         continue;
      g_s[sid].done = true;                       // first break decides the session
      if(r[i].time == lastClosed)
         return dir;
      g_s[sid].status = StringFormat("break at %s happened before the EA saw it: no late entry",
                                     TimeToString(r[i].time, TIME_MINUTES));
      return 0;
     }
   return 0;
  }

//+------------------------------------------------------------------+
//| history-safe time zone (past bars may be on the other side of a  |
//| DST switch than today)                                           |
//+------------------------------------------------------------------+
bool g_histRule = true;

int RuleOffsetAt(const datetime utc) { return IsUSDST(utc) ? 3 * 3600 : 2 * 3600; }

bool HistUsesRule()
  {
   if(InpServerTZ == TZ_EET_US_DST) return true;
   if(InpServerTZ == TZ_FIXED || InpServerTZ == TZ_EU_DST) return false;
   if(!g_autoOk)                    return true;     // tester / no live clock: the rule
   return (g_autoOffsetSec == RuleOffsetAt(TimeGMT())); // broker follows UTC+2/+3 with US DST
  }

datetime HistServerToUTC(const datetime s)
  {
   if(InpServerTZ == TZ_FIXED || InpServerTZ == TZ_EU_DST) return ServerToUTC(s);
   if(g_histRule)              return IsUSDST(s - 2 * 3600) ? s - 3 * 3600 : s - 2 * 3600;
   return s - g_autoOffsetSec;
  }

datetime HistUTCToServer(const datetime u)
  {
   if(InpServerTZ == TZ_FIXED || InpServerTZ == TZ_EU_DST) return UTCToServer(u);
   if(g_histRule)              return u + RuleOffsetAt(u);
   return u + g_autoOffsetSec;
  }

datetime HistLocal(const int sid, const datetime s)
  {
   datetime u = HistServerToUTC(s);
   return (sid == S_NY) ? UTCToNY(u) : UTCToLondon(u);
  }

datetime LiveLocal(const int sid, const datetime s)
  {
   datetime u = ServerToUTC(s);
   return (sid == S_NY) ? UTCToNY(u) : UTCToLondon(u);
  }

int SlotOf(const datetime localT)
  {
   MqlDateTime m;
   TimeToStruct(localT, m);
   return (m.hour * 60 + m.min) / 5;
  }

// first index with r[i].time >= t (r sorted ascending)
int LowerBound(const MqlRates &r[], const int n, const datetime t)
  {
   int lo = 0, hi = n;
   while(lo < hi)
     {
      int mid = (lo + hi) / 2;
      if(r[mid].time < t) lo = mid + 1;
      else                hi = mid;
     }
   return lo;
  }

//+------------------------------------------------------------------+
//| small fast RNG (xorshift64*), seeded per signal                  |
//+------------------------------------------------------------------+
ulong g_rng = 88172645463325252;

void RngSeed(const ulong s)
  {
   g_rng = s * 6364136223846793005 + 1442695040888963407;
   if(g_rng == 0)
      g_rng = 88172645463325252;
  }

ulong RngNext()
  {
   g_rng ^= g_rng >> 12;
   g_rng ^= g_rng << 25;
   g_rng ^= g_rng >> 27;
   return g_rng * 2685821657736338717;
  }

int RngInt(const int n) { return (int)((RngNext() >> 11) % (ulong)n); }

//+------------------------------------------------------------------+
//| time machine: 10,000 replays of the rest of this session         |
//+------------------------------------------------------------------+
struct TMResult
  {
   string why;
   int    days;
   int    bars;
   int    replays;
   double tf, sf, nf, green, avgR, p5, med, p95;
   double targetR, need, got, edge;
   int    hFired, hT, hS, hN;
   double hAvgR;
  };

void TMClear(TMResult &t)
  {
   t.why = ""; t.days = 0; t.bars = 0; t.replays = 0;
   t.tf = 0; t.sf = 0; t.nf = 0; t.green = 0; t.avgR = 0; t.p5 = 0; t.med = 0; t.p95 = 0;
   t.targetR = 0; t.need = 0; t.got = 0; t.edge = 0;
   t.hFired = 0; t.hT = 0; t.hS = 0; t.hN = 0; t.hAvgR = 0;
  }

// one past day of the same rule, exactly like gold.py build_trade; returns false if no trade
bool HistTrade(const int sid, const MqlRates &r[], const int n, const datetime day, const double pt,
               double &rOut, int &kind)            // kind: 1 target, -1 stop, 0 flat
  {
   datetime rs, re, ee, fl;
   WindowsFor(sid, day, true, rs, re, ee, fl);
   int i0 = LowerBound(r, n, rs), i1 = LowerBound(r, n, re);
   double expected = (double)(re - rs) / 300.0;
   if(i1 - i0 < (int)MathMax(1.0, MathFloor(expected * 0.6)))
      return false;
   double hi = r[i0].high, lo = r[i0].low;
   for(int i = i0 + 1; i < i1; i++)
     {
      if(r[i].high > hi) hi = r[i].high;
      if(r[i].low  < lo) lo = r[i].low;
     }
   if(hi - lo < InpMinRangeUSD || hi - lo > InpMaxRangeUSD)
      return false;
   int k = -1, dir = 0;
   for(int j = i1; j < n && r[j].time < ee; j++)
     {
      if(r[j].close > hi)      dir = +1;
      else if(r[j].close < lo) dir = -1;
      if(dir != 0) { k = j + 1; break; }
     }
   if(dir == 0 || k >= n || r[k].time >= fl)
      return false;
   if((dir > 0 && !InpAllowLong) || (dir < 0 && !InpAllowShort))
      return false;
   double sp = MathMax(r[k].spread * pt, InpMinSpreadUSD);
   if(sp > InpMaxSpreadUSD)
      return false;
   double mid = (hi + lo) / 2.0;
   double entry = (dir > 0) ? r[k].open + sp : r[k].open;
   double stop  = (InpStopMode == STOP_RANGE_MID) ? mid : ((dir > 0) ? lo : hi);
   double risk  = (dir > 0) ? entry - stop : stop - entry;
   if(risk <= 0 || risk < InpMinStopSpreadMult * sp)
      return false;
   double target = (dir > 0) ? entry + InpTargetR * risk : entry - InpTargetR * risk;
   double x = 0; kind = 0;
   bool out = false;
   for(int j = k; j < n; j++)
     {
      double spj = MathMax(r[j].spread * pt, InpMinSpreadUSD);
      if(r[j].time >= fl)
        {
         x = (dir > 0) ? r[j].open : r[j].open + spj; kind = 0; out = true;
         break;
        }
      double o = r[j].open, h = r[j].high, l = r[j].low;
      if(dir > 0)
        {
         if(o <= stop)        { x = o;      kind = -1; out = true; }
         else if(o >= target) { x = o;      kind = 1;  out = true; }
         else if(l <= stop)   { x = stop;   kind = -1; out = true; }
         else if(h >= target) { x = target; kind = 1;  out = true; }
        }
      else
        {
         double ao = o + spj, ah = h + spj, al = l + spj;
         if(ao >= stop)        { x = ao;     kind = -1; out = true; }
         else if(ao <= target) { x = ao;     kind = 1;  out = true; }
         else if(ah >= stop)   { x = stop;   kind = -1; out = true; }
         else if(al <= target) { x = target; kind = 1;  out = true; }
        }
      if(out)
         break;
     }
   if(!out)
     {
      int j = n - 1;
      x = (dir > 0) ? r[j].close : r[j].close + MathMax(r[j].spread * pt, InpMinSpreadUSD);
      kind = 0;
     }
   rOut = (dir > 0) ? (x - entry) / risk : (entry - x) / risk;
   return true;
  }

bool RunTimeMachine(const int sid, const int dir, const double entry, const double stop, const double target,
                    TMResult &res)
  {
   TMClear(res);
   g_histRule = HistUsesRule();
   datetime entryBar = iTime(_Symbol, PERIOD_M5, 0);
   datetime today    = g_s[sid].dayKey;            // today's session-local date
   datetime flat     = g_s[sid].flatTime;
   if(entryBar == 0 || flat <= entryBar)
     {
      res.why = "no session time left to replay";
      return false;
     }
   int lookback = (int)(InpTMDays * 1.6) + 10;
   MqlRates r[];
   ArraySetAsSeries(r, false);
   int n = CopyRates(_Symbol, PERIOD_M5, (datetime)(entryBar - (long)lookback * 86400), (datetime)(entryBar - 1), r);
   if(n < 500)
     {
      res.why = StringFormat("only %d M5 bars of history", MathMax(n, 0));
      return false;
     }
   double pt = SymbolInfoDouble(_Symbol, SYMBOL_POINT);

   //--- session-local day and slot of every bar
   datetime ld[];
   int      sl[];
   ArrayResize(ld, n);
   ArrayResize(sl, n);
   for(int i = 0; i < n; i++)
     {
      datetime lt = HistLocal(sid, r[i].time);
      ld[i] = DayStart(lt);
      sl[i] = SlotOf(lt);
     }
   //--- the last InpTMDays weekdays before today
   datetime days[];
   int nd = 0;
   for(int i = 0; i < n; i++)
     {
      datetime d = ld[i];
      if(d >= today) continue;
      int dow = DayOfWeek(d);
      if(dow == 0 || dow == 6) continue;
      if(nd > 0 && days[nd - 1] >= d) continue;
      ArrayResize(days, nd + 1, 128);
      days[nd++] = d;
     }
   int first = MathMax(0, nd - InpTMDays);
   res.days = nd - first;
   if(res.days < 20)
     {
      res.why = StringFormat("only %d past days of history (need 20)", res.days);
      return false;
     }
   datetime cutoff = days[first];

   //--- ratios to the previous close, grouped by slot (counting sort)
   int cnt[289];
   ArrayInitialize(cnt, 0);
   for(int i = 1; i < n; i++)
     {
      datetime d = ld[i];
      if(d < cutoff || d >= today) continue;
      int dow = DayOfWeek(d);
      if(dow == 0 || dow == 6) continue;
      if(r[i].time - r[i - 1].time > 1800 || r[i - 1].close <= 0) continue;
      cnt[sl[i]]++;
     }
   int start[290];
   start[0] = 0;
   for(int s = 0; s < 289; s++)
      start[s + 1] = start[s] + cnt[s];
   int total = start[289];
   double po[], ph[], pl[], pc[], ps[];
   ArrayResize(po, total); ArrayResize(ph, total); ArrayResize(pl, total); ArrayResize(pc, total); ArrayResize(ps, total);
   int pos[289];
   for(int s = 0; s < 289; s++)
      pos[s] = start[s];
   for(int i = 1; i < n; i++)
     {
      datetime d = ld[i];
      if(d < cutoff || d >= today) continue;
      int dow = DayOfWeek(d);
      if(dow == 0 || dow == 6) continue;
      if(r[i].time - r[i - 1].time > 1800 || r[i - 1].close <= 0) continue;
      double prev = r[i - 1].close;
      int q = pos[sl[i]]++;
      po[q] = r[i].open / prev; ph[q] = r[i].high / prev; pl[q] = r[i].low / prev; pc[q] = r[i].close / prev;
      ps[q] = r[i].spread * pt;
     }

   //--- the slots still to come today, entry bar to flat
   int nb = (int)((flat - entryBar + 299) / 300);     // bars opening before flat, like gold.py
   if(nb <= 0)
     {
      res.why = "no session time left to replay";
      return false;
     }
   int cLo[], cHi[];
   ArrayResize(cLo, nb);
   ArrayResize(cHi, nb);
   for(int j = 0; j < nb; j++)
     {
      int s  = SlotOf(LiveLocal(sid, entryBar + j * 300));
      int a  = MathMax(0, s - InpTMWindow);
      int b  = MathMin(287, s + InpTMWindow);
      cLo[j] = start[a];
      cHi[j] = start[b + 1];
      if(cHi[j] - cLo[j] < 15)
        {
         res.why = "too few past bars at some times of day";
         return false;
        }
     }
   res.bars = nb;

   //--- replays
   bool   buy  = (dir > 0);
   double risk = buy ? entry - stop : stop - entry;
   if(risk <= 0)
     {
      res.why = "stop on the wrong side";
      return false;
     }
   res.targetR = buy ? (target - entry) / risk : (entry - target) / risk;
   double ms = InpMinSpreadUSD;
   double p0 = buy ? entry - ms : entry;
   int R = InpTMReplays;
   double finals[];
   ArrayResize(finals, R);
   int tfc = 0, sfc = 0, nfc = 0, gc = 0;
   double sumR = 0;
   RngSeed((ulong)InpTMSeed * 1000003 + (ulong)entryBar);
   for(int k = 0; k < R; k++)
     {
      double P = p0, rr = 0, sp = ms;
      int out = 0;                                   // 1 target, -1 stop
      for(int j = 0; j < nb; j++)
        {
         int q = cLo[j] + RngInt(cHi[j] - cLo[j]);
         sp = MathMax(ps[q], ms);
         double O, H, L, C;
         if(j == 0) { O = P; H = P * ph[q] / po[q]; L = P * pl[q] / po[q]; C = P * pc[q] / po[q]; }
         else       { O = P * po[q]; H = P * ph[q]; L = P * pl[q]; C = P * pc[q]; }
         if(out == 0)
           {
            double x = 0;
            if(buy)
              {
               if(O <= stop)        { out = -1; x = O; }
               else if(O >= target) { out = 1;  x = O; }
               else if(L <= stop)   { out = -1; x = stop; }
               else if(H >= target) { out = 1;  x = target; }
              }
            else
              {
               double aO = O + sp, aH = H + sp, aL = L + sp;
               if(aO >= stop)        { out = -1; x = aO; }
               else if(aO <= target) { out = 1;  x = aO; }
               else if(aH >= stop)   { out = -1; x = stop; }
               else if(aL <= target) { out = 1;  x = target; }
              }
            if(out != 0)
               rr = buy ? (x - entry) / risk : (entry - x) / risk;
           }
         P = C;
        }
      finals[k] = P;
      if(out == 0)
        {
         double x = buy ? P : P + sp;
         rr = buy ? (x - entry) / risk : (entry - x) / risk;
         nfc++;
         if(rr > 0) gc++;
        }
      else if(out > 0) { tfc++; gc++; }
      else             sfc++;
      sumR += rr;
     }
   ArraySort(finals);
   res.replays = R;
   res.tf = 100.0 * tfc / R; res.sf = 100.0 * sfc / R; res.nf = 100.0 * nfc / R; res.green = 100.0 * gc / R;
   res.avgR = sumR / R;
   res.p5  = finals[MathMin(R - 1, (int)(0.05 * R))];
   res.med = finals[MathMin(R - 1, (int)(0.50 * R))];
   res.p95 = finals[MathMin(R - 1, (int)(0.95 * R))];
   double dec = res.tf + res.sf;
   res.need = 100.0 / (1.0 + res.targetR);
   if(dec > 0)
     {
      res.got  = 100.0 * res.tf / dec;
      res.edge = res.got - res.need;
     }
   else
     {
      res.got  = 0;
      res.edge = -100;
     }

   //--- history: the same rule on those same days
   double hsum = 0;
   for(int i = first; i < nd; i++)
     {
      double hr; int kind;
      if(!HistTrade(sid, r, n, days[i], pt, hr, kind))
         continue;
      res.hFired++;
      if(kind > 0) res.hT++; else if(kind < 0) res.hS++; else res.hN++;
      hsum += hr;
     }
   res.hAvgR = (res.hFired > 0) ? hsum / res.hFired : 0;
   return true;
  }

string TMVerdict(const TMResult &t)
  {
   if(t.tf + t.sf <= 0)
      return "no replay reached the stop or target";
   double d = t.edge;
   bool oneR = (MathAbs(t.targetR - 1.0) < 0.05);
   if(MathAbs(d) < 5)  return oneR ? "close to a coin flip" : "close to break-even";
   if(MathAbs(d) < 15) return (d > 0) ? "leans toward the target" : "leans toward the stop";
   return (d > 0) ? "strongly toward the target" : "strongly toward the stop";
  }

string TMLine(const TMResult &t)
  {
   return StringFormat("TM %dx: TP %.0f%% SL %.0f%% open %.0f%% | need %.0f%% got %.0f%% (%+.1f) %s | hist %dd: %d trades %dTP/%dSL avg %+.2fR",
                       t.replays, t.tf, t.sf, t.nf, t.need, t.got, t.edge, TMVerdict(t), t.days, t.hFired, t.hT, t.hS, t.hAvgR);
  }

//+------------------------------------------------------------------+
//| news filter: MT5 economic calendar, high-impact events           |
//+------------------------------------------------------------------+
datetime g_newsFailPushed = 0;
datetime g_tmFailPushed = 0;
bool     g_newsOk = true;
int      g_newsErr = 0;
datetime g_newsChecked = 0;

// keep the calendar loaded and know whether it works (called from OnInit / OnTimer)
void NewsWarmup()
  {
   if(!InpNewsFilter || InTester())
      return;
   datetime now = TimeTradeServer();
   if(g_newsChecked != 0 && now - g_newsChecked < 600)
      return;
   g_newsChecked = now;
   MqlCalendarValue v[];
   ResetLastError();
   bool ok = CalendarValueHistory(v, now - 86400, now + 86400, NULL, InpNewsCurrency);
   int err = GetLastError();
   g_newsOk  = ok || err == ERR_CALENDAR_NO_DATA || err == 0;
   g_newsErr = g_newsOk ? 0 : err;
  }

bool NewsBlocks(string &why)
  {
   why = "";
   if(!InpNewsFilter || InTester())
      return false;
   datetime now = TimeTradeServer();
   MqlCalendarValue v[];
   ResetLastError();
   if(!CalendarValueHistory(v, now - InpNewsAfter * 60, now + InpNewsBefore * 60, NULL, InpNewsCurrency))
     {
      int err = GetLastError();
      if(err == ERR_CALENDAR_NO_DATA || err == 0)
         return false;                               // nothing scheduled in the window
      why = StringFormat("news calendar unavailable (error %d)", err);
      if(InpNewsFailOpen)
        {
         Print("News filter: ", why, ", trading anyway (fail-open)");
         return false;
        }
      why += ", not trading blind";
      return true;
     }
   int n = ArraySize(v);
   for(int i = 0; i < n; i++)
     {
      MqlCalendarEvent e;
      if(!CalendarEventById(v[i].event_id, e))
         continue;
      if(e.importance != CALENDAR_IMPORTANCE_HIGH || e.time_mode != CALENDAR_TIMEMODE_DATETIME)
         continue;
      why = StringFormat("high-impact %s news %s at %s server", InpNewsCurrency, e.name, TimeToString(v[i].time, TIME_MINUTES));
      return true;
     }
   return false;
  }

//+------------------------------------------------------------------+
//| entry                                                            |
//+------------------------------------------------------------------+
void Say(const string msg)
  {
   g_lastMsg = TimeToString(TimeTradeServer(), TIME_DATE | TIME_MINUTES) + "  " + msg;
   Print(msg);
  }

// push to the MetaTrader phone app (MetaQuotes ID set in Tools > Options > Notifications)
datetime g_pushTimes[10];
int      g_pushIdx = 0;
ulong    g_lastPushMs[2];
void Notify(const string msg, const bool asNotice = true)
  {
   if(asNotice)
      BridgeEvent("notice", msg, "");
   if(!InpPush || InTester())
      return;
   if(!TerminalInfoInteger(TERMINAL_NOTIFICATIONS_ENABLED) || !TerminalInfoInteger(TERMINAL_MQID))
      return;
   datetime now = TimeLocal();
   if(g_pushTimes[g_pushIdx] != 0 && now - g_pushTimes[g_pushIdx] < 60)
     {
      Print("push skipped (limit 10 per minute): ", msg);
      return;
     }
   ulong ms = GetTickCount64();
   if(g_lastPushMs[0] != 0 && ms - g_lastPushMs[0] < 1100)
     {
      Sleep((int)(1100 - (ms - g_lastPushMs[0])));    // limit 2 per second: wait instead of losing it
      now = TimeLocal();
     }
   string text = msg;
   if(StringLen(text) > 255)
      text = StringSubstr(text, 0, 252) + "...";
   if(SendNotification(text))
     {
      g_pushTimes[g_pushIdx] = now;
      g_pushIdx = (g_pushIdx + 1) % 10;
      g_lastPushMs[0] = g_lastPushMs[1];             // [0] = the send before last
      g_lastPushMs[1] = GetTickCount64();
     }
   else
      Print("push failed, error ", GetLastError(), ": ", text);
  }

// a signal that was not taken
void SaySkip(const string nm, const int sid)
  {
   Say(nm + ": " + g_s[sid].status);
   BridgeEvent("skip", nm + ": " + g_s[sid].status, "\"session\":" + JS(SessionKey(sid)));
   if(InpPushSkipped)
      Notify("XAU " + nm + ": " + g_s[sid].status, false);
   if(StringFind(g_s[sid].status, "daily limit") >= 0 || StringFind(g_s[sid].status, "trades today") >= 0)
     {
      datetime d = DayStart(TimeTradeServer());
      if(g_limitPushedDay != d)
        {
         g_limitPushedDay = d;
         Notify("XAU: daily limit reached, no more entries today. " + g_s[sid].status, false);
        }
     }
  }

string ServerHM(const datetime t) { return TimeToString(t, TIME_MINUTES); }

// signals-only mode: "this session already signalled today", kept across restarts
string SigGV(const int sid)
  {
   return "XAUSB_" + _Symbol + "_" + IntegerToString(InpMagic) + "_" +
          TimeToString(DayStart(TimeTradeServer()), TIME_DATE) + "_sig" + IntegerToString(sid);
  }

void TryEnter(const int sid, const int dir)
  {
   string nm = SessionName(sid);
   datetime nowS = TimeTradeServer();
   if(nowS >= g_s[sid].flatTime)
     {
      g_s[sid].status = "break, but it is already flat-by time: skipped";
      SaySkip(nm, sid);
      return;
     }
   if(TimeCurrent() - iTime(_Symbol, PERIOD_M5, 0) > 120)
     {
      g_s[sid].status = "break seen late (EA started or reconnected mid-bar): no late entry";
      SaySkip(nm, sid);
      return;
     }
   if(!InTester() && !TerminalInfoInteger(TERMINAL_CONNECTED))
     {
      g_s[sid].status = "break, but the terminal is not connected: skipped";
      SaySkip(nm, sid);
      return;
     }
   bool live = (g_mode == MODE_AUTO_TRADE);
   if(live && !g_hedging && PositionSelect(_Symbol))
     {
      g_s[sid].status = "break, netting account already has a position on this symbol: skipped";
      SaySkip(nm, sid);
      return;
     }
   if((dir > 0 && !InpAllowLong) || (dir < 0 && !InpAllowShort))
     {
      g_s[sid].status = (dir > 0) ? "buy break, buys switched off: done" : "sell break, sells switched off: done";
      SaySkip(nm, sid);
      return;
     }
   if(live && (!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED)))
     {
      g_s[sid].status = "break, but Algo Trading is off";
      SaySkip(nm, sid);
      return;
     }

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double spread = ask - bid;
   if(spread > InpMaxSpreadUSD)
     {
      g_s[sid].status = StringFormat("break, spread %.2f > %.2f: skipped", spread, InpMaxSpreadUSD);
      SaySkip(nm, sid);
      return;
     }

   double mid   = (g_s[sid].hi + g_s[sid].lo) / 2.0;
   double entry = (dir > 0) ? ask : bid;
   double stop  = (InpStopMode == STOP_RANGE_MID) ? mid : ((dir > 0) ? g_s[sid].lo : g_s[sid].hi);
   stop = NormPrice(stop);
   double risk  = (dir > 0) ? entry - stop : stop - entry;
   double stopsLevel = (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double spreadFloor = MathMax(spread, InpMinSpreadUSD);
   if(risk <= 0 || risk < InpMinStopSpreadMult * spreadFloor || risk <= stopsLevel)
     {
      g_s[sid].status = StringFormat("break, stop %.2f too tight (risk %.2f, spread %.2f): skipped", stop, risk, spread);
      SaySkip(nm, sid);
      return;
     }
   double target = NormPrice((dir > 0) ? entry + InpTargetR * risk : entry - InpTargetR * risk);
   if(MathAbs(target - entry) <= stopsLevel)
     {
      g_s[sid].status = "break, target inside the broker's minimum stop distance: skipped";
      SaySkip(nm, sid);
      return;
     }
   ENUM_ORDER_TYPE otype = (dir > 0) ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;

   //--- daily limits
   double realized; int entries; bool entered[3];
   if(!TodayHistory(realized, entries, entered))
     {
      g_s[sid].status = "break, but today's trade history is not available: skipped";
      SaySkip(nm, sid);
      return;
     }
   if(entered[sid])
     {
      g_s[sid].status = "already traded this session";
      return;
     }
   if(entries >= InpMaxTradesPerDay)
     {
      g_s[sid].status = StringFormat("break, %d trades today = limit: skipped", entries);
      SaySkip(nm, sid);
      return;
     }

   //--- size
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double lossPerLot = LossAt(otype, 1.0, entry, stop);
   if(lossPerLot <= 0)
     {
      g_s[sid].status = "break, cannot price the stop (OrderCalcProfit failed): skipped";
      SaySkip(nm, sid);
      return;
     }
   double vmin = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double vmax = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double vstep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(vstep <= 0)
      vstep = vmin;
   if(vstep <= 0)
     {
      g_s[sid].status = "break, broker reports no volume step: skipped";
      SaySkip(nm, sid);
      return;
     }
   double lots;
   if(InpRiskMode == RISK_PERCENT)
     {
      double riskMoney = balance * g_riskPct / 100.0;
      lots = MathFloor((riskMoney / lossPerLot) / vstep + 1e-9) * vstep;
      if(lots < vmin)
        {
         g_s[sid].status = StringFormat("break, min lot %.2f would risk %.2f > %.2f (%.2f%%): skipped",
                                        vmin, vmin * lossPerLot, riskMoney, g_riskPct);
         SaySkip(nm, sid);
         return;
        }
     }
   else
      lots = MathFloor(InpFixedLot / vstep + 1e-9) * vstep;
   lots = NormalizeDouble(MathMin(lots, vmax), VolumeDigits());
   if(lots < vmin || lots <= 0)
     {
      g_s[sid].status = StringFormat("break, lot %.2f below broker minimum %.2f: skipped", lots, vmin);
      SaySkip(nm, sid);
      return;
     }
   double newRisk = lots * lossPerLot;

   bool missing;
   double openRisk = OpenRisk(missing);
   double dayStartBalance = balance - realized;
   double budget = dayStartBalance * InpDailyLossPercent / 100.0;
   double used = MathMax(0.0, -realized) + openRisk;
   if(missing || used + newRisk > budget * 1.0001)
     {
      g_s[sid].status = StringFormat("break, daily limit: lost %.2f + open risk %.2f + this %.2f > %.2f: skipped",
                                     MathMax(0.0, -realized), openRisk, newRisk, budget);
      SaySkip(nm, sid);
      return;
     }

   //--- margin
   double margin = 0;
   if(live && (!OrderCalcMargin(otype, _Symbol, lots, entry, margin) || margin > AccountInfoDouble(ACCOUNT_MARGIN_FREE) * 0.9))
     {
      g_s[sid].status = StringFormat("break, not enough free margin for %.2f lots: skipped", lots);
      SaySkip(nm, sid);
      return;
     }

   //--- news filter
   string newsWhy;
   if(NewsBlocks(newsWhy))
     {
      g_s[sid].status = "break, skipped: " + newsWhy;
      SaySkip(nm, sid);
      if(StringFind(newsWhy, "unavailable") >= 0)
        {
         datetime d0 = DayStart(TimeTradeServer());
         if(g_newsFailPushed != d0) { g_newsFailPushed = d0; Notify("XAU " + nm + ": " + newsWhy, false); }
        }
      else if(!InpPushSkipped)
         Notify("XAU " + nm + " " + (dir > 0 ? "BUY" : "SELL") + " skipped: " + newsWhy, false);
      return;
     }

   //--- time machine
   string tmText = "";
   if(InpTMMode != TM_OFF)
     {
      TMResult tm;
      bool tmOk = RunTimeMachine(sid, dir, entry, stop, target, tm);
      tmText = tmOk ? TMLine(tm) : ("TM: " + tm.why);
      Say(nm + ": " + tmText);
      if(InpTMMode == TM_GATE && (!tmOk || tm.edge < InpTMMinEdge))
        {
         g_s[sid].status = tmOk ? StringFormat("break, skipped by time machine: edge %+.1f < %.1f (%s)", tm.edge,
                                               InpTMMinEdge, TMVerdict(tm))
                                : "break, skipped: time machine could not run (" + tm.why + ")";
         Say(nm + ": " + g_s[sid].status);
         Notify("XAU " + nm + " " + (dir > 0 ? "BUY" : "SELL") + " SKIPPED. " + tmText, false);
         BridgeEvent("tm", tmText, StringFormat("\"session\":%s,\"side\":%s,\"entry\":%.2f,\"sl\":%.2f,\"tp\":%.2f,\"ok\":%s,\"edge\":%.1f,\"take\":false,\"why\":%s",
                    JS(SessionKey(sid)), JS(dir > 0 ? "buy" : "sell"), entry, stop, target, (tmOk ? "true" : "false"),
                    (tmOk ? tm.edge : -100.0), JS(tmOk ? TMVerdict(tm) : tm.why)));
         if(!tmOk)
           {
            datetime d0 = DayStart(TimeTradeServer());
            if(g_tmFailPushed != d0)
              {
               g_tmFailPushed = d0;
               Notify("XAU: time machine cannot run (" + tm.why + "). In gate mode every signal is skipped until this is fixed.", false);
              }
           }
         return;
        }
      Notify("XAU " + nm + " " + (dir > 0 ? "BUY" : "SELL") + (InpTMMode == TM_GATE ? " TAKE. " : ". ") + tmText, false);
      BridgeEvent("tm", tmText, StringFormat("\"session\":%s,\"side\":%s,\"entry\":%.2f,\"sl\":%.2f,\"tp\":%.2f,\"ok\":true,\"edge\":%.1f,\"take\":true,\"why\":%s,\"tp_first\":%.1f,\"sl_first\":%.1f,\"need\":%.1f,\"got\":%.1f,\"hist_trades\":%d,\"hist_avg_r\":%.3f",
                 JS(SessionKey(sid)), JS(dir > 0 ? "buy" : "sell"), entry, stop, target, tm.edge, JS(TMVerdict(tm)),
                 tm.tf, tm.sf, tm.need, tm.got, tm.hFired, tm.hAvgR));
     }

   //--- signals-only: send the ticket to the phone, no order
   if(!live)
     {
      RememberEntry();
      g_s[sid].signalSent = true;
      if(!InTester())
        {
         GlobalVariableSet(SigGV(sid), 1.0);
         GlobalVariablesFlush();
        }
      string cur = AccountInfoString(ACCOUNT_CURRENCY);
      string msg = StringFormat("XAU %s SIGNAL: %s %s %.2f lots now ~%.2f | SL %.2f | TP %.2f (%.1fR) | risk %.2f %s (%.2f%%) | close by %s server",
                                nm, (dir > 0 ? "BUY" : "SELL"), _Symbol, lots, entry, stop, target, InpTargetR,
                                newRisk, cur, g_riskPct, ServerHM(g_s[sid].flatTime));
      g_s[sid].status = StringFormat("SIGNAL sent: %s %.2f lots ~%.2f, SL %.2f, TP %.2f", (dir > 0 ? "BUY" : "SELL"),
                                     lots, entry, stop, target);
      Say(nm + ": " + g_s[sid].status);
      Notify(msg, false);
      BridgeEvent("signal", msg, StringFormat("\"session\":%s,\"side\":%s,\"lots\":%.2f,\"entry\":%.2f,\"sl\":%.2f,\"tp\":%.2f,\"flat_by\":%s",
                  JS(SessionKey(sid)), JS(dir > 0 ? "buy" : "sell"), lots, entry, stop, target, JS(ServerHM(g_s[sid].flatTime))));
      return;
     }

   //--- send
   g_trade.SetExpertMagicNumber((ulong)(InpMagic + sid));
   g_trade.SetDeviationInPoints((ulong)InpSlippagePoints);
   g_trade.SetTypeFillingBySymbol(_Symbol);
   string cm = StringFormat("XAU %s %s %.1fR", (sid == S_LONDON ? "LDN" : (sid == S_NY ? "NY" : "ASIA")),
                            (dir > 0 ? "buy" : "sell"), InpTargetR);
   bool ok = (dir > 0) ? g_trade.Buy(lots, _Symbol, 0.0, stop, target, cm)
                       : g_trade.Sell(lots, _Symbol, 0.0, stop, target, cm);
   uint rc = g_trade.ResultRetcode();
   double fill = g_trade.ResultPrice();
   string rcText = g_trade.ResultRetcodeDescription();
   if(ok && (rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_PLACED || rc == TRADE_RETCODE_DONE_PARTIAL))
     {
      RememberEntry();
      EnsureStops(sid, stop, target);
      g_s[sid].status = StringFormat("%s %.2f lots at %.2f, SL %.2f, TP %.2f, risk %.2f %s",
                                     (dir > 0 ? "BOUGHT" : "SOLD"), lots, fill, stop, target,
                                     newRisk, AccountInfoString(ACCOUNT_CURRENCY));
      Say(nm + ": " + g_s[sid].status);
      Notify("XAU " + nm + ": " + g_s[sid].status + StringFormat(" | flat by %s server", ServerHM(g_s[sid].flatTime)), false);
      BridgeEvent("fill", g_s[sid].status, StringFormat("\"session\":%s,\"side\":%s,\"lots\":%.2f,\"price\":%.2f,\"sl\":%.2f,\"tp\":%.2f,\"risk\":%.2f,\"flat_by\":%s",
                  JS(SessionKey(sid)), JS(dir > 0 ? "buy" : "sell"), lots, fill, stop, target, newRisk, JS(ServerHM(g_s[sid].flatTime))));
     }
   else
     {
      g_s[sid].status = StringFormat("order failed: %u %s", rc, rcText);
      Say(nm + ": " + g_s[sid].status);
      Notify("XAU " + nm + ": " + g_s[sid].status);
     }
  }

// every position of this session must carry its stop; repair it or close it
void EnsureStops(const int sid, const double stop, const double target)
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol || PositionGetInteger(POSITION_MAGIC) != InpMagic + sid)
         continue;
      if(PositionGetDouble(POSITION_SL) > 0)
         continue;
      g_trade.SetExpertMagicNumber((ulong)(InpMagic + sid));
      if(g_trade.PositionModify(tk, stop, target))
        {
         Say(SessionName(sid) + ": stop was missing on #" + (string)tk + ", set to " + DoubleToString(stop, _Digits));
         Notify("XAU " + SessionName(sid) + ": stop was missing on #" + (string)tk + ", set to " + DoubleToString(stop, _Digits));
        }
      else
        {
         Say(SessionName(sid) + ": stop missing on #" + (string)tk + " and could not be set: closing it");
         Notify("XAU " + SessionName(sid) + ": stop missing on #" + (string)tk + " and could not be set: closing it");
         g_trade.PositionClose(tk);
        }
     }
  }

//+------------------------------------------------------------------+
//| flat by session end                                              |
//+------------------------------------------------------------------+
void ManageFlat()
  {
   datetime now = TimeTradeServer();
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;
      long mg = PositionGetInteger(POSITION_MAGIC);
      if(!IsOurMagic(mg))
         continue;
      int sid = (int)(mg - InpMagic);
      datetime opened = (datetime)PositionGetInteger(POSITION_TIME);
      datetime oUtc = ServerToUTC(opened);
      datetime oDay = DayStart(sid == S_NY ? UTCToNY(oUtc) : UTCToLondon(oUtc));
      bool late     = (now >= g_s[sid].flatTime);
      bool leftover = (oDay < g_s[sid].dayKey);           // opened on an earlier session day
      bool noStop   = (PositionGetDouble(POSITION_SL) <= 0);  // a position must never run without a stop
      if(!late && !leftover && !noStop)
         continue;
      g_trade.SetExpertMagicNumber((ulong)mg);
      g_trade.SetDeviationInPoints((ulong)InpSlippagePoints);
      g_trade.SetTypeFillingBySymbol(_Symbol);
      if(g_trade.PositionClose(tk))
         Say(SessionName(sid) + ": flat by " + TimeToString(g_s[sid].flatTime, TIME_MINUTES) + ", closed #" + (string)tk);
      else if(now - g_lastFailMsg >= 300)
        {
         g_lastFailMsg = now;
         string fm = SessionName(sid) + ": close #" + (string)tk + " failed: " + (string)g_trade.ResultRetcode() + " " +
                     g_trade.ResultRetcodeDescription() + " (retrying)";
         Say(fm);
         Notify("XAU " + fm + ". Check the position on your phone.");
        }
     }
  }

//+------------------------------------------------------------------+
//| panel                                                            |
//+------------------------------------------------------------------+
void Panel()
  {
   if(!InpShowPanel)
      return;
   string tz;
   if(InpServerTZ == TZ_FIXED)
      tz = StringFormat("fixed UTC%+d", InpFixedServerOffset);
   else if(InpServerTZ == TZ_EU_DST)
      tz = StringFormat("UTC%+d / %+d with EU DST", InpFixedServerOffset, InpFixedServerOffset + 1);
   else if(InpServerTZ == TZ_AUTO && g_autoOk)
     {
      datetime nowS = TimeTradeServer();
      int ruleOff = IsUSDST(nowS - 2 * 3600) ? 3 * 3600 : 2 * 3600;
      tz = StringFormat("auto UTC%+.1f", g_autoOffsetSec / 3600.0);
      if(ruleOff != g_autoOffsetSec)
         tz += StringFormat("  (! the Strategy Tester assumes UTC%+d: set Fixed for tests)", ruleOff / 3600);
     }
   else
      tz = "UTC+2/+3 (US DST rule)";
   string s = StringFormat("XAU Session Breakout   %s   %s   server tz: %s\n", _Symbol,
                           (g_paused ? "PAUSED (no new entries)" : (g_mode == MODE_AUTO_TRADE ? "AUTO TRADING" : "SIGNALS ONLY (no new orders)")), tz);
   if(InpPush)
      s += (TerminalInfoInteger(TERMINAL_NOTIFICATIONS_ENABLED) && TerminalInfoInteger(TERMINAL_MQID))
           ? "phone push: on\n" : "phone push: OFF - Tools > Options > Notifications: enable + enter MetaQuotes ID\n";
   s += StringFormat("risk %.2f%%/trade, daily limit %.2f%%, max %d trades/day, target %.1fR, stop %s\n",
                     g_riskPct, InpDailyLossPercent, InpMaxTradesPerDay, InpTargetR,
                     (InpStopMode == STOP_RANGE_MID ? "range mid" : "range opposite"));
   s += StringFormat("time machine: %s%s | news filter: %s\n",
                     (InpTMMode == TM_OFF ? "off" : (InpTMMode == TM_INFO ? "report only" : "gate")),
                     (InpTMMode == TM_GATE ? StringFormat(" (edge >= %.1f pts, %d replays, %d days)", InpTMMinEdge, InpTMReplays, InpTMDays) : ""),
                     (InpNewsFilter ? (InTester() ? "off in tester" :
                        (g_newsOk ? StringFormat("%s high impact -%d/+%d min", InpNewsCurrency, InpNewsBefore, InpNewsAfter)
                                  : StringFormat("CALENDAR ERROR %d (%s)", g_newsErr, InpNewsFailOpen ? "trading anyway" : "entries skipped"))) : "off"));
   for(int k = 0; k < 3; k++)
     {
      if(!g_s[k].enabled)
         continue;
      s += StringFormat("%-13s range %s-%s, entries to %s, flat %s (server): %s\n", SessionName(k),
                        TimeToString(g_s[k].rangeStart, TIME_MINUTES), TimeToString(g_s[k].rangeEnd, TIME_MINUTES),
                        TimeToString(g_s[k].entryEnd, TIME_MINUTES), TimeToString(g_s[k].flatTime, TIME_MINUTES),
                        g_s[k].status);
     }
   if(BridgeOn())
      s += "bridge: on (Common\\Files\\" + BR_DIR + "), control #" + (string)g_ctrlSeq + ", session " + g_sessOverride +
           StringFormat(", risk %.2f%%\n", g_riskPct);
   if(!g_hedging)
      s += "netting account: one EA position at a time on this symbol; manual trades on it merge and close with it\n";
   if(g_lastMsg != "")
      s += "last: " + g_lastMsg;
   Comment(s);
  }

//+------------------------------------------------------------------+
//| server bridge: Common\Files\xau_bridge\ (for Hermes / scripts)   |
//|  status.json  - written every 15 s (account, positions, sessions)|
//|  events.jsonl - one JSON line per event (tm, fill, close, skip...)|
//|  control.txt  - read on change: seq, paused, mode, risk_pct,     |
//|                 session, close_all                               |
//|  XAUUSD_M5.csv- daily M5 export for gold.py                      |
//+------------------------------------------------------------------+

bool BridgeOn() { return InpBridge && !InTester(); }

string JEsc(const string s)
  {
   string r = s;
   StringReplace(r, "\\", "\\\\");
   StringReplace(r, "\"", "\\\"");
   StringReplace(r, "\r", " ");
   StringReplace(r, "\n", " ");
   StringReplace(r, "\t", " ");
   int n = StringLen(r);
   for(int i = 0; i < n; i++)
      if(StringGetCharacter(r, i) < 32)
         StringSetCharacter(r, i, ' ');
   return r;
  }

string JS(const string s) { return "\"" + JEsc(s) + "\""; }
string JN(const double v, const int d = 2) { return DoubleToString(v, d); }
string JT(const datetime t) { return "\"" + TimeToString(t, TIME_DATE | TIME_MINUTES | TIME_SECONDS) + "\""; }

// write a whole file atomically: tmp + move
bool BridgeWriteFile(const string name, const string text)
  {
   string tmp = BR_DIR + "\\" + name + ".tmp";
   string dst = BR_DIR + "\\" + name;
   int h = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON, '\t', CP_UTF8);
   if(h == INVALID_HANDLE)
      return false;
   FileWriteString(h, text);
   FileClose(h);
   return FileMove(tmp, FILE_COMMON, dst, FILE_COMMON | FILE_REWRITE);
  }

void BridgeEvent(const string kind, const string text, const string extra = "")
  {
   if(!BridgeOn())
      return;
   string line = "{\"ts\":" + JT(TimeTradeServer()) + ",\"kind\":" + JS(kind) + ",\"text\":" + JS(text) +
                 (extra != "" ? "," + extra : "") + "}\n";
   int h = FileOpen(BR_DIR + "\\events.jsonl", FILE_READ | FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON |
                    FILE_SHARE_READ, '\t', CP_UTF8);
   if(h == INVALID_HANDLE)
      return;
   FileSeek(h, 0, SEEK_END);
   FileWriteString(h, line);
   FileClose(h);
  }

string SessionKey(const int sid) { return (sid == S_LONDON) ? "london" : (sid == S_NY ? "ny" : "asia"); }

void ApplySessions()
  {
   string o = g_sessOverride;
   for(int k = 0; k < 3; k++)
     {
      if(o == "all")                         g_s[k].enabled = true;
      else if(o == "london" || o == "ny" || o == "asia") g_s[k].enabled = (SessionKey(k) == o);
      else                                   g_s[k].enabled = (InpSession == SESSION_ALL) || ((int)InpSession == k);
     }
  }

void CloseAllOurs(const string why)
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol || !IsOurMagic(PositionGetInteger(POSITION_MAGIC)))
         continue;
      g_trade.SetExpertMagicNumber((ulong)PositionGetInteger(POSITION_MAGIC));
      g_trade.SetDeviationInPoints((ulong)InpSlippagePoints);
      g_trade.SetTypeFillingBySymbol(_Symbol);
      if(g_trade.PositionClose(tk))
         Say("close-all (" + why + "): closed #" + (string)tk);
      else
         Notify("XAU close-all (" + why + "): #" + (string)tk + " failed " + (string)g_trade.ResultRetcode() +
                " " + g_trade.ResultRetcodeDescription() + ". Close it in the app.");
     }
  }

string CloseNonceGV() { return "XAUSB_" + _Symbol + "_" + IntegerToString(InpMagic) + "_closenonce"; }

// read control.txt when it changes
void BridgeControl()
  {
   string name = BR_DIR + "\\control.txt";
   if(!FileIsExist(name, FILE_COMMON))
      return;
   int h = FileOpen(name, FILE_READ | FILE_TXT | FILE_ANSI | FILE_COMMON | FILE_SHARE_READ | FILE_SHARE_WRITE);
   if(h == INVALID_HANDLE)
      return;
   long seq = -1;
   long login = -1;
   string paused = "", mode = "", risk = "", sess = "", closeNonce = "";
   while(!FileIsEnding(h))
     {
      string ln = FileReadString(h);
      StringTrimLeft(ln);
      StringTrimRight(ln);
      int eq = StringFind(ln, "=");
      if(eq <= 0 || StringGetCharacter(ln, 0) == '#')
         continue;
      string k = StringSubstr(ln, 0, eq), v = StringSubstr(ln, eq + 1);
      StringTrimRight(k); StringTrimLeft(v);
      StringToLower(k);   StringToLower(v);
      if(k == "seq")            seq = StringToInteger(v);
      else if(k == "login")     login = StringToInteger(v);
      else if(k == "paused")    paused = v;
      else if(k == "mode")      mode = v;
      else if(k == "risk_pct")  risk = v;
      else if(k == "session")   sess = v;
      else if(k == "close_all") closeNonce = v;
     }
   FileClose(h);
   if(seq == g_ctrlSeq)
      return;
   g_ctrlSeq = seq;
   if(login > 0 && login != AccountInfoInteger(ACCOUNT_LOGIN))
     {
      BridgeEvent("control", "control #" + (string)seq + " ignored: written for account " + (string)login, "\"seq\":" + (string)seq);
      return;
     }
   string applied = "";
   if(paused != "")
     {
      g_paused = (paused == "1" || paused == "true" || paused == "yes");
      applied += (g_paused ? "paused " : "running ");
     }
   if(mode == "auto" || mode == "signals")
     {
      if(mode == "auto" && InpMode == MODE_SIGNALS_ONLY && !InpBridgeMayEnable)
         applied += "mode=auto REFUSED (EA set to signals only) ";
      else
        {
         g_mode = (mode == "auto") ? MODE_AUTO_TRADE : MODE_SIGNALS_ONLY;
         applied += "mode=" + mode + " ";
        }
     }
   if(risk != "")
     {
      double rv = StringToDouble(risk);
      if(rv > 0)
        {
         g_riskPct = MathMin(rv, InpRiskPercent);          // can only lower the risk set in the EA
         applied += "risk=" + DoubleToString(g_riskPct, 2) + "% ";
        }
     }
   if(sess == "default" || sess == "london" || sess == "ny" || sess == "asia" || sess == "all")
     {
      if(sess == "default" || InpBridgeMayEnable || InpSession == SESSION_ALL ||
         (sess != "all" && SessionKey((int)InpSession) == sess))
        {
         g_sessOverride = sess;
         ApplySessions();
         applied += "session=" + sess + " ";
        }
      else
         applied += "session=" + sess + " REFUSED (not enabled in the EA inputs) ";
     }
   if(closeNonce != "" && closeNonce != "0")
     {
      double nonce = StringToDouble(closeNonce);
      double last = GlobalVariableCheck(CloseNonceGV()) ? GlobalVariableGet(CloseNonceGV()) : 0.0;
      if((long)TimeGMT() - (long)(nonce / 1000.0) > 600)
         applied += "close_all expired (older than 10 min, not executed) ";
      else if(nonce != last)
        {
         GlobalVariableSet(CloseNonceGV(), nonce);
         GlobalVariablesFlush();
         CloseAllOurs("control");
         applied += "close_all ";
        }
     }
   string msg = "control #" + (string)seq + " applied: " + (applied == "" ? "nothing" : applied);
   Say(msg);
   BridgeEvent("control", msg, "\"seq\":" + (string)seq);
   g_statusAt = 0;                                    // write status right away
  }

void BridgeNewsToday()
  {
   if(!InpNewsFilter)
      return;
   datetime now = TimeTradeServer();
   if(g_newsTodayAt != 0 && now - g_newsTodayAt < 3600)
      return;
   g_newsTodayAt = now;
   datetime d0 = DayStart(now);
   MqlCalendarValue v[];
   ResetLastError();
   if(!CalendarValueHistory(v, d0, d0 + 86400, NULL, InpNewsCurrency))
     {
      g_newsTodayJson = "[]";
      return;
     }
   string s = "[";
   int added = 0;
   for(int i = 0; i < ArraySize(v); i++)
     {
      MqlCalendarEvent e;
      if(!CalendarEventById(v[i].event_id, e))
         continue;
      if(e.importance != CALENDAR_IMPORTANCE_HIGH || e.time_mode != CALENDAR_TIMEMODE_DATETIME)
         continue;
      s += (added > 0 ? "," : "") + "{\"time\":" + JS(TimeToString(v[i].time, TIME_MINUTES)) + ",\"name\":" + JS(e.name) + "}";
      added++;
     }
   g_newsTodayJson = s + "]";
  }

void BridgeStatus()
  {
   datetime now = TimeTradeServer();
   if(g_statusAt != 0 && now - g_statusAt < 15)
      return;
   g_statusAt = now;
   long mode = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   double realized; int entries; bool entered[3];
   bool hist = TodayHistory(realized, entries, entered);
   string s = "{";
   s += "\"ts\":" + JT(now) + ",\"ts_utc\":" + JT(TimeGMT()) + ",\"ea_version\":\"2.10\"";
   s += ",\"symbol\":" + JS(_Symbol);
   s += ",\"account\":{\"login\":" + (string)AccountInfoInteger(ACCOUNT_LOGIN) + ",\"server\":" + JS(AccountInfoString(ACCOUNT_SERVER)) +
        ",\"mode\":" + JS(mode == ACCOUNT_TRADE_MODE_REAL ? "real" : (mode == ACCOUNT_TRADE_MODE_DEMO ? "demo" : "contest")) +
        ",\"currency\":" + JS(AccountInfoString(ACCOUNT_CURRENCY)) +
        ",\"balance\":" + JN(AccountInfoDouble(ACCOUNT_BALANCE)) + ",\"equity\":" + JN(AccountInfoDouble(ACCOUNT_EQUITY)) +
        ",\"margin_free\":" + JN(AccountInfoDouble(ACCOUNT_MARGIN_FREE)) + "}";
   s += ",\"ea\":{\"mode\":" + JS(g_mode == MODE_AUTO_TRADE ? "auto" : "signals") + ",\"paused\":" + (g_paused ? "true" : "false") +
        ",\"risk_pct\":" + JN(g_riskPct) + ",\"risk_pct_max\":" + JN(InpRiskPercent) +
        ",\"session_override\":" + JS(g_sessOverride) + ",\"control_seq\":" + (string)g_ctrlSeq +
        ",\"time_machine\":" + JS(InpTMMode == TM_OFF ? "off" : (InpTMMode == TM_INFO ? "report" : "gate")) +
        ",\"tm_min_edge\":" + JN(InpTMMinEdge, 1) +
        ",\"news\":" + JS(!InpNewsFilter ? "off" : (g_newsOk ? "ok" : "error " + (string)g_newsErr)) +
        ",\"algo_trading\":" + ((TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && MQLInfoInteger(MQL_TRADE_ALLOWED)) ? "true" : "false") +
        ",\"connected\":" + (TerminalInfoInteger(TERMINAL_CONNECTED) ? "true" : "false") +
        ",\"push\":" + ((InpPush && TerminalInfoInteger(TERMINAL_NOTIFICATIONS_ENABLED) && TerminalInfoInteger(TERMINAL_MQID)) ? "true" : "false") + "}";
   s += ",\"today\":{\"history_ok\":" + (hist ? "true" : "false") + ",\"realized\":" + JN(realized) + ",\"trades\":" + (string)entries +
        ",\"max_trades\":" + (string)InpMaxTradesPerDay + ",\"daily_loss_pct\":" + JN(InpDailyLossPercent) + "}";
   s += ",\"positions\":[";
   int np = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol || !IsOurMagic(PositionGetInteger(POSITION_MAGIC)))
         continue;
      int sid = (int)(PositionGetInteger(POSITION_MAGIC) - InpMagic);
      s += (np > 0 ? "," : "") + "{\"ticket\":" + (string)tk + ",\"session\":" + JS(SessionName(sid)) +
           ",\"side\":" + JS(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "buy" : "sell") +
           ",\"lots\":" + JN(PositionGetDouble(POSITION_VOLUME)) + ",\"open\":" + JN(PositionGetDouble(POSITION_PRICE_OPEN)) +
           ",\"sl\":" + JN(PositionGetDouble(POSITION_SL)) + ",\"tp\":" + JN(PositionGetDouble(POSITION_TP)) +
           ",\"profit\":" + JN(PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP)) +
           ",\"opened\":" + JT((datetime)PositionGetInteger(POSITION_TIME)) + ",\"flat_by\":" + JS(ServerHM(g_s[sid].flatTime)) + "}";
      np++;
     }
   s += "],\"sessions\":[";
   for(int k = 0; k < 3; k++)
     {
      s += (k > 0 ? "," : "") + "{\"name\":" + JS(SessionName(k)) + ",\"key\":" + JS(SessionKey(k)) +
           ",\"enabled\":" + (g_s[k].enabled ? "true" : "false") +
           ",\"range\":" + JS(ServerHM(g_s[k].rangeStart) + "-" + ServerHM(g_s[k].rangeEnd)) +
           ",\"entry_end\":" + JS(ServerHM(g_s[k].entryEnd)) + ",\"flat\":" + JS(ServerHM(g_s[k].flatTime)) +
           ",\"status\":" + JS(g_s[k].status) + "}";
     }
   s += "],\"news_today\":" + g_newsTodayJson;
   s += ",\"export\":" + JS(g_lastExport);
   s += ",\"last\":" + JS(g_lastMsg) + "}";
   BridgeWriteFile("status.json", s);
  }

// once a day after the daily break: M5 bars for gold.py (same format as ExportBars)
void BridgeExport(const bool force)
  {
   if(InpBridgeExportBars <= 0)
      return;
   datetime now = TimeTradeServer();
   datetime d0 = DayStart(now);
   bool missing = !FileIsExist(BR_DIR + "\\" + _Symbol + "_M5.csv", FILE_COMMON);
   bool inBreak = (now - d0 >= 600 && now - d0 < 3000);  // 00:10-00:50 server: gold's daily break
   if(!force && (g_exportDay == d0 || (!inBreak && !missing)))
      return;
   MqlRates r[];
   ArraySetAsSeries(r, false);
   int n = CopyRates(_Symbol, PERIOD_M5, 1, InpBridgeExportBars, r);
   if(n <= 0)
      return;
   g_exportDay = d0;
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   long off = (long)(TimeTradeServer() - TimeGMT());
   off = (long)MathRound((double)off / 1800.0) * 1800;
   string tmp = BR_DIR + "\\" + _Symbol + "_M5.csv.tmp";
   int h = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON, '\t', CP_UTF8);
   if(h == INVALID_HANDLE)
      return;
   FileWriteString(h, "# symbol=" + _Symbol + "\n");
   FileWriteString(h, "# point=" + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_POINT), digits) + "\n");
   FileWriteString(h, "# digits=" + IntegerToString(digits) + "\n");
   FileWriteString(h, "# server_gmt_offset_now_sec=" + IntegerToString(off) + "\n");
   FileWriteString(h, "# exported_server_time=" + TimeToString(now, TIME_DATE | TIME_MINUTES) + "\n");
   FileWriteString(h, "# broker=" + AccountInfoString(ACCOUNT_COMPANY) + "\n");
   FileWriteString(h, "time,open,high,low,close,tick_volume,spread\n");
   for(int i = 0; i < n; i++)
      FileWriteString(h, TimeToString(r[i].time, TIME_DATE | TIME_MINUTES) + "," +
                      DoubleToString(r[i].open, digits) + "," + DoubleToString(r[i].high, digits) + "," +
                      DoubleToString(r[i].low, digits) + "," + DoubleToString(r[i].close, digits) + "," +
                      IntegerToString(r[i].tick_volume) + "," + IntegerToString(r[i].spread) + "\n");
   FileClose(h);
   if(FileMove(tmp, FILE_COMMON, BR_DIR + "\\" + _Symbol + "_M5.csv", FILE_COMMON | FILE_REWRITE))
     {
      g_lastExport = BR_DIR + "/" + _Symbol + "_M5.csv " + TimeToString(now, TIME_DATE | TIME_MINUTES) + " (" + (string)n + " bars)";
      BridgeEvent("export", g_lastExport, "\"bars\":" + (string)n);
     }
  }

void BridgeTick()
  {
   if(!BridgeOn())
      return;
   string want = BR_ROOT + "\\" + (string)AccountInfoInteger(ACCOUNT_LOGIN) + "_" + _Symbol;
   if(want != g_brDir && AccountInfoInteger(ACCOUNT_LOGIN) > 0)
     {
      g_brDir = want;                                 // the login was not known yet at start
      FolderCreate(BR_ROOT, FILE_COMMON);
      FolderCreate(g_brDir, FILE_COMMON);
      g_ctrlSeq = -1;
     }
   BridgeControl();
   BridgeNewsToday();
   BridgeExport(false);
   BridgeStatus();
  }

//+------------------------------------------------------------------+
//| events                                                           |
//+------------------------------------------------------------------+
int OnInit()
  {
   g_mLondonOpen = ParseHM(InpLondonOpen);   g_mLondonEntryEnd = ParseHM(InpLondonEntryEnd); g_mLondonFlat = ParseHM(InpLondonFlat);
   g_mNYOpen     = ParseHM(InpNYOpen);       g_mNYEntryEnd     = ParseHM(InpNYEntryEnd);     g_mNYFlat     = ParseHM(InpNYFlat);
   g_mAsiaStart  = ParseHM(InpAsiaStart);    g_mAsiaEnd        = ParseHM(InpAsiaEnd);
   g_mAsiaEntryEnd = ParseHM(InpAsiaEntryEnd); g_mAsiaFlat     = ParseHM(InpAsiaFlat);
   if(g_mLondonOpen < 0 || g_mLondonEntryEnd < 0 || g_mLondonFlat < 0 || g_mNYOpen < 0 || g_mNYEntryEnd < 0 ||
      g_mNYFlat < 0 || g_mAsiaStart < 0 || g_mAsiaEnd < 0 || g_mAsiaEntryEnd < 0 || g_mAsiaFlat < 0)
     {
      Print("A session time is not HH:MM");
      return INIT_PARAMETERS_INCORRECT;
     }
   if(InpRiskMode == RISK_FIXED_LOT && InpFixedLot < SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN))
     {
      Print("Fixed lot is below the broker's minimum lot ", DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN), 2));
      return INIT_PARAMETERS_INCORRECT;
     }
   if(InpRangeMinutes < 5 || InpTargetR <= 0 || InpRiskPercent <= 0 || InpRiskPercent > 5 ||
      InpDailyLossPercent <= 0 || InpMaxTradesPerDay < 1 || (InpRiskMode == RISK_FIXED_LOT && InpFixedLot <= 0))
     {
      Print("Check the inputs: range >= 5 min, target > 0, risk 0-5%, daily limit > 0, trades/day >= 1");
      return INIT_PARAMETERS_INCORRECT;
     }
   if(g_mLondonOpen + InpRangeMinutes > g_mLondonEntryEnd || g_mLondonEntryEnd >= g_mLondonFlat ||
      g_mNYOpen + InpRangeMinutes > g_mNYEntryEnd || g_mNYEntryEnd >= g_mNYFlat ||
      g_mAsiaStart >= g_mAsiaEnd || g_mAsiaEnd > g_mAsiaEntryEnd || g_mAsiaEntryEnd >= g_mAsiaFlat)
     {
      Print("Session times must run in order: range start < range end <= entry end < flat");
      return INIT_PARAMETERS_INCORRECT;
     }

   if(InpTMReplays < 1000 || InpTMReplays > 100000 || InpTMDays < 20 || InpTMDays > 250 ||
      InpTMWindow < 0 || InpTMWindow > 6 || InpNewsBefore < 0 || InpNewsAfter < 0)
     {
      Print("Check the time machine / news inputs: replays 1000-100000, days 20-250, window 0-6, minutes >= 0");
      return INIT_PARAMETERS_INCORRECT;
     }
   if(InpNewsFilter && InTester())
      Print("Strategy Tester: the economic calendar is only available online, so the news filter is off in this test.");
   int needBars = (int)((InpTMDays * 1.6 + 10) * 288);
   long maxBars = TerminalInfoInteger(TERMINAL_MAXBARS);
   if(InpTMMode == TM_GATE && !InTester() && maxBars > 0 && maxBars < needBars)
     {
      Print("Time machine needs about ", needBars, " M5 bars of history: Tools > Options > Charts > Max bars in chart ",
            "must be at least that (or Unlimited). Now: ", maxBars);
      return INIT_PARAMETERS_INCORRECT;
     }
   if(InpServerTZ == TZ_AUTO && !InTester())
     {
      UpdateAutoOffset();
      if(g_autoOk && g_autoOffsetSec != RuleOffsetAt(TimeGMT()))
         Print("Broker clock is UTC", (g_autoOffsetSec >= 0 ? "+" : ""), DoubleToString(g_autoOffsetSec / 3600.0, 1),
               ", not the usual UTC+2/+3 US-DST rule. For a correct time machine pool across DST changes, set ",
               "'Broker server time zone' to Fixed (no DST) or EU DST with the base offset.");
     }
   if(InTester() && PeriodSeconds(_Period) > 300)
     {
      Print("Run the Strategy Tester on M5 or M1: on higher timeframes the EA only sees one tick per bar.");
      return INIT_PARAMETERS_INCORRECT;
     }

   g_mode    = InpMode;
   g_riskPct = InpRiskPercent;
   for(int k = 0; k < 3; k++)
     {
      g_s[k].dayKey  = 0;
      g_s[k].status  = "";
      g_s[k].offsetUsed = 0;
      g_s[k].signalSent = false;
      g_s[k].flatReminded = false;
     }


   if(StringFind(_Symbol, "XAU") < 0 && StringFind(_Symbol, "GOLD") < 0)
      Print("Warning: ", _Symbol, " does not look like gold. The default range filters and spread limit are in USD for XAUUSD.");

   g_hedging = (AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING);
   if(!g_hedging)
      Print("Netting account: the EA will only enter when there is no other position on ", _Symbol,
            ". A hedging account is recommended (each session's trade stays separate).");
   long mode = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   Print("XAU Session Breakout on ", _Symbol, ", account ", (mode == ACCOUNT_TRADE_MODE_REAL ? "REAL" : (mode == ACCOUNT_TRADE_MODE_DEMO ? "demo" : "contest")),
         ", risk ", DoubleToString(InpRiskPercent, 2), "% per trade");
   if(mode == ACCOUNT_TRADE_MODE_REAL)
      Print("REAL ACCOUNT: this EA will place live orders with real money.");

   UpdateAutoOffset();
   if(InpServerTZ == TZ_AUTO && InTester())
      Print("Strategy Tester: the live server clock is not available, using the UTC+2/+3 US-DST rule. "
            "If your broker uses another time zone, set 'Broker server time zone' to Fixed.");

   if(InpMode == MODE_SIGNALS_ONLY)
      Print("Signals only: no new orders. Positions this EA opened earlier are still closed at their flat-by time.");
   if(InpPush && !InTester() && (!TerminalInfoInteger(TERMINAL_NOTIFICATIONS_ENABLED) || !TerminalInfoInteger(TERMINAL_MQID)))
      Print("Phone notifications are off. Tools > Options > Notifications: tick 'Enable Push Notifications' and enter ",
            "the MetaQuotes ID from the MT5 phone app (Settings > Chat and messages / Messages).");
   if(_UninitReason != REASON_CHARTCHANGE)
      Notify(StringFormat("XAU EA v2 started: %s, %s account, %s, risk %.2f%%/trade, time machine %s, news filter %s",
                       _Symbol, (mode == ACCOUNT_TRADE_MODE_REAL ? "REAL" : (mode == ACCOUNT_TRADE_MODE_DEMO ? "demo" : "contest")),
                       (InpMode == MODE_AUTO_TRADE ? "auto trading" : "signals only"), InpRiskPercent,
                       (InpTMMode == TM_OFF ? "off" : (InpTMMode == TM_INFO ? "report" : "gate")), (InpNewsFilter ? "on" : "off")), false);

   ApplySessions();
   if(BridgeOn())
     {
      g_brDir = BR_ROOT + "\\" + (string)AccountInfoInteger(ACCOUNT_LOGIN) + "_" + _Symbol;
      FolderCreate(BR_ROOT, FILE_COMMON);
      FolderCreate(g_brDir, FILE_COMMON);
      g_ctrlMtime = 0;
      g_ctrlSeq   = -1;                               // re-apply control after a chart/input change
      BridgeControl();                                // keep pause / mode / overrides across restarts
      BridgeEvent("start", StringFormat("EA %s started on %s", "2.10", _Symbol));
     }
   NewsWarmup();
   EventSetTimer(5);
   g_lastBar = 0;
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   Comment("");
  }

void Step()
  {
   UpdateAutoOffset();
   datetime now = TimeTradeServer();
   for(int k = 0; k < 3; k++)
      RefreshSession(k, now);       // all three, so flat-by still works if a setting changed

   ManageFlat();
   if(g_mode == MODE_SIGNALS_ONLY)
      for(int k = 0; k < 3; k++)
         if(g_s[k].signalSent && !g_s[k].flatReminded && now >= g_s[k].flatTime)
           {
            g_s[k].flatReminded = true;
            Notify("XAU " + SessionName(k) + ": flat-by time " + ServerHM(g_s[k].flatTime) +
                   " server. Close the trade from this signal if it is still open.");
           }

   datetime bar = iTime(_Symbol, PERIOD_M5, 0);
   if(bar == 0 || bar == g_lastBar)
      return;
   g_lastBar = bar;

   // restart safety: a session that already traded today is done
   double realized; int entries; bool entered[3];
   bool histOk = TodayHistory(realized, entries, entered);

   for(int k = 0; k < 3; k++)
     {
      if(!g_s[k].enabled || g_s[k].done)
         continue;
      bool signalled = (!InTester() && GlobalVariableCheck(SigGV(k)));
      if(signalled)
         g_s[k].signalSent = true;                    // keep the flat-time reminder after a restart
      bool traded = HasPosition(k) || (histOk && entered[k]) || signalled;
      if(traded)
        {
         g_s[k].done = true;
         if(StringFind(g_s[k].status, "BOUGHT") < 0 && StringFind(g_s[k].status, "SOLD") < 0)
            g_s[k].status = "already traded this session";
         continue;
        }
      if(bar < g_s[k].rangeEnd)
         continue;
      if(!g_s[k].rangeReady)
         if(!BuildRange(k))
            continue;
      int dir = CheckBreak(k);
      if(dir != 0 && g_paused)
        {
         g_s[k].status = (dir > 0) ? "buy break while PAUSED: not taken" : "sell break while PAUSED: not taken";
         SaySkip(SessionName(k), k);
        }
      else if(dir != 0)
         TryEnter(k, dir);
      else if(!g_s[k].done && bar >= g_s[k].entryEnd)
        {
         g_s[k].done   = true;
         g_s[k].status = "no break by entry end: done for today";
        }
     }
   Panel();
  }

// push every close of this EA's positions with its result and reason
void OnTradeTransaction(const MqlTradeTransaction &trans, const MqlTradeRequest &request, const MqlTradeResult &result)
  {
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD || trans.deal == 0)
      return;
   if(!HistoryDealSelect(trans.deal))
      return;
   if(HistoryDealGetString(trans.deal, DEAL_SYMBOL) != _Symbol)
      return;
   long mg = HistoryDealGetInteger(trans.deal, DEAL_MAGIC);
   if(!IsOurMagic(mg))
      return;
   long entry = HistoryDealGetInteger(trans.deal, DEAL_ENTRY);
   if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY && entry != DEAL_ENTRY_INOUT)
      return;
   double pl = HistoryDealGetDouble(trans.deal, DEAL_PROFIT) + HistoryDealGetDouble(trans.deal, DEAL_SWAP) +
               HistoryDealGetDouble(trans.deal, DEAL_COMMISSION) + HistoryDealGetDouble(trans.deal, DEAL_FEE);
   long reason = HistoryDealGetInteger(trans.deal, DEAL_REASON);
   string why = (reason == DEAL_REASON_SL) ? "stop loss" : (reason == DEAL_REASON_TP) ? "take profit" :
                (reason == DEAL_REASON_EXPERT) ? "flat-by time / EA" : (reason == DEAL_REASON_SO) ? "STOP OUT" :
                (reason == DEAL_REASON_CLIENT || reason == DEAL_REASON_MOBILE || reason == DEAL_REASON_WEB) ? "closed manually" :
                "closed by broker";
   int sid = (int)(mg - InpMagic);
   string msg = StringFormat("XAU %s closed: %s, %.2f lots at %.2f, result %+.2f %s", SessionName(sid), why,
                             HistoryDealGetDouble(trans.deal, DEAL_VOLUME), HistoryDealGetDouble(trans.deal, DEAL_PRICE),
                             pl, AccountInfoString(ACCOUNT_CURRENCY));
   Say(msg);
   Notify(msg, false);
   BridgeEvent("close", msg, StringFormat("\"session\":%s,\"reason\":%s,\"lots\":%.2f,\"price\":%.2f,\"pl\":%.2f",
               JS(SessionKey(sid)), JS(why), HistoryDealGetDouble(trans.deal, DEAL_VOLUME),
               HistoryDealGetDouble(trans.deal, DEAL_PRICE), pl));
  }

void OnTick()  { Step(); }
void OnTimer() { NewsWarmup(); Step(); BridgeTick(); Panel(); }
//+------------------------------------------------------------------+
