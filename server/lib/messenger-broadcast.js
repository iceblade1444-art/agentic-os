// MILA writing into a channel on her own, without anyone asking.
//
// The morning brief and ERP alerts already reach one person through the inbox
// and a push. In a company, most of that is news for a team rather than for the
// owner alone: a late order belongs in the production channel where the people
// who can fix it are already talking.
//
// She posts only into channels that exist and that she was added to. Nothing is
// auto-created, because a bot that invents channels ends up talking to itself.

import { MILA_MEMBER_ID, messenger } from "./messenger.js";
import { onboarding } from "./onboarding.js";

const MILA_AUTHOR = { id: MILA_MEMBER_ID, name: "Mila" };
const clean = (value, max) => String(value ?? "").trim().slice(0, max);

export function createBroadcaster(options = {}) {
  const store = options.messenger || messenger;
  const settings = options.onboarding || onboarding;

  function targetChannel(name, onBehalfOf = null) {
    const channel = store.channelByName(name);
    if (!channel) return null;
    // Being named is not enough: she has to be a member, which is how the team
    // switches her off — remove her from the channel and she stops posting.
    if (!channel.memberIds.includes(MILA_MEMBER_ID)) return null;
    // And the person whose brief this is has to be in the room too. The channel
    // name comes from their own profile field, which is free text: without this,
    // typing the name of a channel they are not in publishes their day plan to a
    // team they cannot even read, signed "Mila" so it does not look like theirs.
    if (onBehalfOf && !channel.memberIds.includes(onBehalfOf.id)) return null;
    return channel;
  }

  // Returns null when there is nowhere to post, so callers can stay silent
  // rather than inventing a destination.
  function post(channelName, text, { kind = "agent", onBehalfOf = null } = {}) {
    const body = clean(text, 4000);
    if (!body) return null;
    const channel = targetChannel(channelName, onBehalfOf);
    if (!channel) return null;
    return store.send(channel.id, MILA_AUTHOR, { text: body, kind });
  }

  function channelFor(user, key) {
    const profile = settings.get(user).profile || {};
    return clean(profile[key], 80);
  }

  return {
    post,
    targetChannel,
    // Where a given user's automatic posts should go, or "" when they have not
    // chosen a channel and nothing should be broadcast.
    briefChannel: (user) => channelFor(user, "briefChannel"),
    alertChannel: (user) => channelFor(user, "alertChannel"),
  };
}

export const broadcaster = createBroadcaster();
