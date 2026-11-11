//+------------------------------------------------------------------+
//|                                                   ExportBars.mq5 |
//|  Script: writes this chart's symbol as M5 bars to a CSV in       |
//|  MQL5\Files, with the broker's time zone in the header, for      |
//|  trader-gold/gold.py (compare, backtest, replay).                |
//+------------------------------------------------------------------+
#property copyright "trader-gold, day-trader-skill pack"
#property version   "1.00"
#property script_show_inputs

input int InpBars = 200000;      // M5 bars to export (about 2.5 years)

void OnStart()
  {
   MqlRates r[];
   ArraySetAsSeries(r, false);
   int n = -1;
   for(int attempt = 0; attempt < 10 && n <= 0; attempt++)
     {
      n = CopyRates(_Symbol, PERIOD_M5, 1, InpBars, r);   // from shift 1: skip the bar still forming
      if(n <= 0)
         Sleep(500);                          // history still downloading
     }
   if(n <= 0)
     {
      Print("CopyRates failed, error ", GetLastError(), ". Open an M5 chart, scroll back, and run again.");
      return;
     }

   string fn = _Symbol + "_M5_export.csv";
   int h = FileOpen(fn, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE)
     {
      Print("Cannot write ", fn, ", error ", GetLastError());
      return;
     }
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   long off = (long)(TimeTradeServer() - TimeGMT());
   off = (long)MathRound((double)off / 1800.0) * 1800;

   FileWriteString(h, "# symbol=" + _Symbol + "\n");
   FileWriteString(h, "# point=" + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_POINT), digits) + "\n");
   FileWriteString(h, "# digits=" + IntegerToString(digits) + "\n");
   FileWriteString(h, "# server_gmt_offset_now_sec=" + IntegerToString(off) + "\n");
   FileWriteString(h, "# exported_server_time=" + TimeToString(TimeTradeServer(), TIME_DATE | TIME_MINUTES) + "\n");
   FileWriteString(h, "# broker=" + AccountInfoString(ACCOUNT_COMPANY) + "\n");
   FileWriteString(h, "time,open,high,low,close,tick_volume,spread\n");
   for(int i = 0; i < n; i++)
     {
      FileWriteString(h, TimeToString(r[i].time, TIME_DATE | TIME_MINUTES) + "," +
                      DoubleToString(r[i].open, digits) + "," + DoubleToString(r[i].high, digits) + "," +
                      DoubleToString(r[i].low, digits) + "," + DoubleToString(r[i].close, digits) + "," +
                      IntegerToString(r[i].tick_volume) + "," + IntegerToString(r[i].spread) + "\n");
     }
   FileClose(h);
   string path = TerminalInfoString(TERMINAL_DATA_PATH) + "\\MQL5\\Files\\" + fn;
   Print("Exported ", n, " bars, ", TimeToString(r[0].time, TIME_DATE), " to ",
         TimeToString(r[n - 1].time, TIME_DATE | TIME_MINUTES), ", server UTC",
         (off >= 0 ? "+" : ""), DoubleToString(off / 3600.0, 1), " -> ", path);
   Comment("Exported ", n, " bars to ", path);
  }
//+------------------------------------------------------------------+
