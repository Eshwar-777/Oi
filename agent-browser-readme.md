# agent-browser

`agent-browser` is a terminal-first browser automation utility designed for scripted and agent-driven workflows. It can open pages, inspect UI structure, interact with elements, manage session state, and control tabs and dialogs from the command line.

It supports both ref-based interaction from snapshots and traditional selector-based commands.

## Ways to install it

### System-wide install

Use a global install if you want the normal command available everywhere:

```bash
npm install -g agent-browser
agent-browser install
```

This is typically the best option for repeated use.

### Run without installing globally

If you only want to test it quickly:

```bash
npx agent-browser install
npx agent-browser open example.com
```

This works fine, but startup tends to be slower than a global install.

### Add it to a project

To keep the dependency version pinned inside a repo:

```bash
npm install agent-browser
npx agent-browser install
```

Then run it through `npx` or a package script.

### macOS with Homebrew

```bash
brew install agent-browser
agent-browser install
```

### Build from source

```bash
git clone https://github.com/vercel-labs/agent-browser
cd agent-browser
pnpm install
pnpm build
pnpm build:native
pnpm link --global
agent-browser install
```

### Linux dependency setup

Some Linux machines need browser libraries installed separately:

```bash
agent-browser install --with-deps
```

## Minimal example

```bash
agent-browser open example.com
agent-browser snapshot
agent-browser click @e2
agent-browser fill @e3 "user@example.com"
agent-browser get text @e1
agent-browser screenshot page.png
agent-browser close
```

The same tool also accepts standard selectors:

```bash
agent-browser click "#submit"
agent-browser fill "#email" "user@example.com"
agent-browser find role button click --name "Continue"
```

## Main command categories

### Page actions

```bash
agent-browser open <url>
agent-browser click <sel>
agent-browser dblclick <sel>
agent-browser focus <sel>
agent-browser hover <sel>
agent-browser type <sel> <text>
agent-browser fill <sel> <text>
agent-browser select <sel> <val>
agent-browser check <sel>
agent-browser uncheck <sel>
agent-browser drag <src> <tgt>
agent-browser upload <sel> <files>
agent-browser scroll <dir> [px]
agent-browser scrollintoview <sel>
```

### Keyboard and pointer controls

```bash
agent-browser press <key>
agent-browser keyboard type <text>
agent-browser keyboard inserttext <text>
agent-browser keydown <key>
agent-browser keyup <key>
agent-browser mouse move <x> <y>
agent-browser mouse down [button]
agent-browser mouse up [button]
agent-browser mouse wheel <dy> [dx]
```

### Read page state

```bash
agent-browser snapshot
agent-browser get text <sel>
agent-browser get html <sel>
agent-browser get value <sel>
agent-browser get attr <sel> <attr>
agent-browser get title
agent-browser get url
agent-browser get count <sel>
agent-browser get box <sel>
agent-browser get styles <sel>
```

### Capture output

```bash
agent-browser screenshot [path]
agent-browser screenshot --annotate
agent-browser pdf <path>
agent-browser eval <js>
```

### Wait conditions

```bash
agent-browser wait <selector>
agent-browser wait <ms>
agent-browser wait --text "Welcome"
agent-browser wait --url "**/dashboard"
agent-browser wait --load networkidle
agent-browser wait --fn "window.ready === true"
```

Supported load states are:

- `load`
- `domcontentloaded`
- `networkidle`

### Element state checks

```bash
agent-browser is visible <sel>
agent-browser is enabled <sel>
agent-browser is checked <sel>
```

### Semantic lookup helpers

```bash
agent-browser find role <role> <action> [value]
agent-browser find text <text> <action>
agent-browser find label <label> <action> [value]
agent-browser find placeholder <text> <action> [value]
agent-browser find alt <text> <action>
agent-browser find title <text> <action>
agent-browser find testid <id> <action> [value]
agent-browser find first <sel> <action> [value]
agent-browser find last <sel> <action> [value]
agent-browser find nth <n> <sel> <action> [value]
```

Common actions:

- `click`
- `fill`
- `type`
- `hover`
- `focus`
- `check`
- `uncheck`
- `text`

Examples:

```bash
agent-browser find role button click --name "Submit"
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "user@example.com"
agent-browser find first ".item" click
agent-browser find nth 2 "a" text
```

### Browser environment settings

```bash
agent-browser set viewport <w> <h>
agent-browser set device <name>
agent-browser set geo <lat> <lng>
agent-browser set offline [on|off]
agent-browser set headers <json>
agent-browser set credentials <u> <p>
agent-browser set media [dark|light]
```

### Cookies and storage

```bash
agent-browser cookies
agent-browser cookies set <name> <val>
agent-browser cookies clear

agent-browser storage local
agent-browser storage local <key>
agent-browser storage local set <k> <v>
agent-browser storage local clear

agent-browser storage session
```

### Network behavior

```bash
agent-browser network route <url>
agent-browser network route <url> --abort
agent-browser network route <url> --body <json>
agent-browser network unroute [url]
agent-browser network requests
agent-browser network requests --filter api
```

### Tabs, frames, dialogs, and browser lifecycle

```bash
agent-browser tab
agent-browser tab new [url]
agent-browser tab <n>
agent-browser tab close [n]
agent-browser window new
agent-browser frame <sel>
agent-browser frame main
agent-browser dialog accept [text]
agent-browser dialog dismiss
agent-browser connect <port>
agent-browser close
```
