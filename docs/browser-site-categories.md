# Browser Site Categories

Use category playbooks, not site-specific hacks.

## Core rule

Most browser mistakes come from skipping a category-specific transition:

- lookup -> choose entity -> act
- draft -> review -> submit
- filter -> verify result set -> open record
- navigate -> authenticate/consent -> resume

The runtime should attach these rules based on page shape and user goal, not on a hardcoded website name.

## Categories

1. Search and result lists
- Examples: Google, GitHub search, internal admin search, app launchers
- Must separate query entry from result selection
- Must verify the chosen result before downstream edits

2. Messaging and chat
- Examples: WhatsApp, Slack, Teams, Discord, Telegram
- Must select the intended thread/contact/channel before typing or sending
- Must verify active conversation identity before send/reply

3. Email clients
- Examples: Gmail, Outlook, Superhuman
- Must select recipient/thread before composing or replying
- Must distinguish search box, subject, body, and send controls

4. CRM and people records
- Examples: Salesforce, HubSpot, Zoho
- Must open the exact lead/contact/account/deal before editing notes or fields
- Must verify record header identity after selection

5. Support and ticketing
- Examples: Zendesk, Freshdesk, Jira Service Management
- Must open the intended ticket before replying or changing status
- Must verify ticket id/title before comment/resolve actions

6. Knowledge/docs/wiki
- Examples: Notion, Confluence, Google Docs, Coda
- Must open the target document/page first
- Must distinguish global search from document editor

7. Project/task management
- Examples: Jira, Linear, Asana, Trello, ClickUp
- Must select the exact issue/card/task before edit/transition
- Must verify task title or issue key before comment/close

8. File storage and drives
- Examples: Google Drive, Dropbox, OneDrive
- Must select the correct file/folder before share/move/delete
- Must verify selected item identity before destructive actions

9. E-commerce and marketplaces
- Examples: Amazon, Shopify admin, Flipkart, Etsy
- Must select exact product/cart item/order before checkout/refund/edit
- Must verify totals and destination before confirmation

10. Banking and fintech
- Examples: banking portals, wallets, broker apps
- Must verify payee/account/amount before submit
- Must treat final confirmation as high risk

11. Booking and travel
- Examples: airline, hotel, rail, ride booking
- Must verify traveler, date, route, fare before final action
- Must expect frequent modal and upsell interruptions

12. Media and streaming
- Examples: YouTube, Spotify, Netflix
- Must distinguish global search from in-player controls
- Must verify selected media before play/add/save

13. Social and creator tools
- Examples: LinkedIn, Instagram, X, YouTube Studio
- Must verify audience/account/post identity before publishing or messaging

14. Dashboards and analytics
- Examples: GA, Mixpanel, Grafana, admin BI tools
- Must verify filters/time range before export or interpretation
- Must prefer non-destructive navigation over edits

15. Auth, consent, onboarding, and security gates
- Examples: login pages, MFA prompts, cookie banners
- Must unblock safely, never improvise around security challenges

16. Forms and applications
- Examples: job applications, onboarding forms, government portals
- Must distinguish label/field pairs correctly
- Must validate required fields before submit

17. Tables, grids, and back-office tools
- Examples: admin consoles, warehouse dashboards, finance ops tools
- Must select the right row before editing or bulk actions
- Must verify row identity after sort/filter changes

18. Scheduling and calendars
- Examples: Google Calendar, Calendly, internal schedulers
- Must verify date, timezone, attendees, and title before save/send

19. Developer tools and cloud consoles
- Examples: GitHub, Vercel, AWS console, CI dashboards
- Must verify repo/project/environment before deploy/merge/run
- Must be conservative around destructive/admin actions

20. Unknown or mixed apps
- Examples: new SaaS products, internal tools
- Fall back to generic rules:
- snapshot -> find entity -> open entity -> verify identity -> act -> verify outcome

## Recommended playbooks

Start with reusable playbooks, not 1000 site-specific skills:

- `search-results`
- `entity-selection-and-activation`
- `messaging-compose-send`
- `record-open-edit-save`
- `form-fill-submit`
- `auth-consent-recovery`
- `checkout-confirmation`
- `table-filter-select-row`
- `calendar-schedule-confirm`
- `document-open-edit-share`

## Immediate product rule

Before typing into a downstream editor or clicking a send/submit control:

- if the task names a person/record/thread and the current page still shows that target as a selectable result,
- open that result first,
- then verify that the selection context changed.

That rule is generic and should be enforced in runtime, not left entirely to the LLM.
