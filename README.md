# Atlassian Graphql (Chrome DevTools Extension)

Chrome DevTools extension that detects GraphQL network requests and shows HTTP + GraphQL details in a dedicated DevTools panel.

## Installation in Chrome

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked**.
4. Select this folder: `/Users/raina/dev/github/chrome-graphql`.
5. Open any website that performs GraphQL requests.
6. Open DevTools (`Cmd+Option+I` on macOS or `F12`/`Ctrl+Shift+I` on Windows/Linux).
7. Open the **Atlassian Graphql** tab inside DevTools.

## Usage

1. Trigger GraphQL requests in the page.
2. Select a request in the left list.
3. Inspect details on the right side (summary, headers, bodies, GraphQL fields).
4. Use filter and "Only errors" to narrow down requests.

## Important limitations

- Chrome extensions cannot directly modify the native Network tab rows or columns.
- This project adds a dedicated DevTools panel that mirrors and enriches the same requests.

## Development notes

No build step is required. The extension is plain HTML/CSS/JS.

After code changes:

1. Go to `chrome://extensions`.
2. Click **Reload** on this extension.
3. Re-open DevTools for the target tab if needed.
