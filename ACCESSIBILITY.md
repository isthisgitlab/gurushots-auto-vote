# Accessibility

GuruShots Auto Vote uses a shared interface for its desktop, Android, and web apps.
A command-line interface is also available.

This document describes existing accessibility behavior and how to report barriers.
It does not claim WCAG conformance or verified compatibility with every assistive technology.

## Dialog keyboard behavior

Dialogs built with the shared modal component move focus into the dialog when it opens.
Tab and Shift+Tab keep focus inside the dialog. Escape closes dialogs that allow dismissal.
When it closes, the component restores focus to the previously focused element.
Titled dialogs expose their title to assistive technology.

## Report an accessibility barrier

Open an [issue using the issue template](https://github.com/isthisgitlab/gurushots-auto-vote/issues/new?template=issue.md)
and select "Accessibility barrier". Include what you can:

- App version or commit, affected interface, operating system, and browser if relevant.
- Screen reader or other assistive technology and version.
- Input method, zoom or text size, and theme.
- The task you tried, steps to reproduce, expected behavior, and actual behavior.
- Any workaround that helps.

A text description is enough. Screenshots and recordings are optional.
Remove passwords, tokens, pairing links, and personal data from reports and attachments.
Report vulnerabilities privately through the [security policy](SECURITY.md).

## Checks for interface changes

Contributors should check each affected flow:

- Use the keyboard to reach controls and confirm that focus remains visible.
- Open and close dialogs. Check focus placement, Tab and Shift+Tab, Escape, and focus restoration.
- Check control names, dialog titles, and status or error announcements with a screen reader.
- Increase zoom or text size. Check that content and controls remain usable.
- Check contrast in the affected themes. Do not rely on color alone to communicate meaning.

These are checks to perform, not a record of completed accessibility testing.
