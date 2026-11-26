# Coming from other Facebook and Instagram extensions

xrnsoc takes over the parts of three other extensions that hide or slow
down Facebook and Instagram, so that one extension with no network access
is the only one reading those sites (Messenger and Instagram's messages
included). This page says what each one did, where that is in xrnsoc now,
and what was left out and why.

| Extension | What it reads | What it sends |
| --- | --- | --- |
| Ad Blocker for Facebook | facebook.com | nothing |
| Social Fixer for Facebook | facebook.com | a daily ping, news, filter lists and Facebook's class map from socialfixer.com and matt-kruse.github.io |
| Antigram | instagram.com | its options page loads a stylesheet from a CDN; an uninstall survey |

xrnsoc keeps to its rules: no requests of its own, no new permissions, short
labels, and a site's markup is found by roles, labels and link shapes, not
by generated class names.

## Ad Blocker for Facebook

It has no settings: it hides feed posts whose label reads "Sponsored" in 27
languages, the right column's sponsored box, ads in the Watch feed, and on
old builds Marketplace and photo-page ads.

- **Feed, sidebar, Watch and Marketplace ads** were in xrnsoc already
  (*Feed ads*, *Sidebar ads*, *Marketplace ads*, all on by default), with
  more signals than a label's text.
- **The label's languages:** xrnsoc now also reads "Sponsored" in the 12
  languages it lacked (Czech, Slovak, Romanian, Canadian French, Filipino,
  Hungarian, Greek, Hebrew, Arabic, Hindi, Thai, and Chinese in both
  scripts), matched whole like the others, so a Page whose name starts
  with the word keeps its posts.
- Left out: the hooks for builds Facebook no longer serves (the classic
  site's ids and class names, `m.facebook.com`'s 2019 markup).

## Antigram

Switches for Instagram: Reels, Explore, Stories, Posts, Threads links,
suggested accounts, and sending the home feed to *Following*.

- **Reels:** xrnsoc's *Recommended Reels* (on by default) already hides the
  Reels tab and the feed's reels, sends the Reels tab to the feed and keeps
  a reel opened from a link to that one reel.
- **Stories, Threads links:** already xrnsoc switches (*Stories*, *Threads
  links*). **Posts** (the whole home feed) has no xrnsoc switch: hide it with
  the picker.
- **Suggested accounts** (new, Feed, on by default): the "Suggested for you"
  box in the right column and in the feed, found by its link to
  `/explore/people/`: the smallest box around that link holding a Follow
  button, never one holding a post.
- **Explore** (new, Feed, off): on `/explore/` the grid of recommended posts
  goes, and any search box above it stays; the menu's Explore entry goes
  where it is labelled Explore (in English or Vietnamese), not where the
  same address is the Search entry. Tag, place and search result pages
  still open: you asked for those.
- **Following feed** (new, Feed, off): the home feed opens as *Following*
  (`/?variant=following`); *For you* (`?variant=home` or no variant) is
  sent there. *Favorites* is left alone.

## Social Fixer

Social Fixer does much more, mostly through its own menu: filters, a
"hide parts of the page" list fetched from its server, display tweaks,
"Mark Read", a friends-list tracker and font settings.

- **Post Loading Pause** (on in Social Fixer by default, after 10 posts)
  becomes **Pause feed** (new, Facebook, Feed, off): after 10 posts, the
  rest of the feed and its loading skeleton wait behind a "Paused · 10 more"
  bar; clicking it lets 10 more in. With the skeleton out of view, Facebook
  stops fetching posts. Posts other switches hide don't count.
- **Keyword filters and hiding parts of the page** are xrnsoc's words,
  switches and picker.
- Left out:
  - anything that needs Social Fixer's server: its subscribed filters,
    hideables and tweaks, news and Facebook's class map;
  - the friends-list tracker and the filtered-chat check, which read your
    friends list and message requests (the check reads a Facebook address,
    mbasic, that no longer exists);
  - Mark Read, filter tabs, the comment navigator, scroll-to-comment, fonts,
    Enter-key behaviour and the other editing helpers: they change how
    Facebook works rather than hide what distracts.

## Where it lives

- `src/sites/instagram.js`: `suggestedAccounts`, `explore` and
  `followingFeed`, with the rest of Instagram's rules.
- `src/sites/facebook.js`: `feedPause`.
- `src/content/engine.js`: the ad label's words (`AD_WORD`, `AD_START`).
- Tests: `test/smoke.js` and `test/browser.js` against the fixtures in
  `test/fixtures/`, which are made up.
