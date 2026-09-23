> **Version 2026-09-23.**

syrup uses very few cookies and no advertising or cross-site tracking. Because of that, we do not show a cookie banner.

## Strictly necessary

| Name | Purpose | Lifetime |
|---|---|---|
| `authjs.session-token` (or `__Secure-authjs.session-token`) | Keeps you signed in | 30 days |
| `authjs.csrf-token`, `authjs.callback-url` | Protects the sign-in flow against forgery | Session |
| `syrup.theme`, `syrup.ui` (local storage) | Remembers interface preferences on this device | Until cleared |

## Analytics (can be turned off)

| Name | Purpose | Lifetime |
|---|---|---|
| `ph_*` (PostHog) | A random identifier so we can count sessions and see which features are used. Text and inputs in session replays are masked. | 1 year |

Turn analytics off in **Settings → Privacy**, or send the browser **Do Not Track** signal; syrup honors it. When analytics is off, PostHog cookies are not set and existing ones are cleared.

## Third parties

Signing in with Google sets Google's own cookies on google.com under Google's policies. syrup does not set cookies for any advertiser or social network.

Questions: sadakhan2002@gmail.com
