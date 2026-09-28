# Calmgram

Instagram for friends only. You keep:

- **Your friends' posts**: the home feed is locked to the *Following* feed (only people you follow, newest first)
- **Stories**
- **DMs**: messages, replies, and reels a friend sends you still open
- **Friends' profiles and search**

These are removed:

- **Reels tab**: blocked, and it sends you to your inbox instead
- **Explore**: blocked (search still works)
- **Suggested posts and ads** in the feed
- **Endless scroll**: the feed stops after 20 posts or at posts older than 3 days, then shows "You're all caught up"

It is a small script that runs on top of the real instagram.com. You log in as usual and your friends and
messages are all there. It doesn't use a password or a third-party server, and it doesn't collect any data.

> Why not a separate app? Instagram doesn't let other apps read your feed or DMs. Anything that claims to
> do this has to ask for your password, which risks getting your account banned. Filtering the official
> site is the safe way.

## Install

### Computer (Chrome, Edge, Brave)
1. Download this repo (Code → Download ZIP) and unzip it.
2. Go to `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the `extension` folder.
4. Open instagram.com.

### Computer (Firefox)
Go to `about:debugging` → *This Firefox* → **Load Temporary Add-on**, then pick `extension/manifest.json`.
Or use the userscript method below with Tampermonkey or Violentmonkey.

### iPhone / iPad
1. Install the free **Userscripts** app from the App Store and turn it on under
   Settings → Safari → Extensions.
2. Save `extension/calmgram.user.js` into the Userscripts folder.
3. Open instagram.com in Safari, log in, and use it from there. Tip: Share → *Add to Home Screen*.
4. Delete the Instagram app. This is the step that matters most.

### Android
Install **Firefox**, add the **Tampermonkey** add-on, and open `calmgram.user.js` in Tampermonkey.
Then use instagram.com in Firefox instead of the app.

## Settings
The top of `extension/calmgram.user.js` has these settings:

```js
const MAX_POSTS = 20;      // feed stops after this many posts
const MAX_AGE_DAYS = 3;    // hide feed posts older than this
```

## If something breaks
Instagram changes its website often. If Reels or suggestions come back, open an issue and the filters can be updated.
