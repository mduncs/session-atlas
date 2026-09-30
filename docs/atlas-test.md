# Atlas comparison preview

Open two terminal windows and run `atlas` in one and `atlas-test` in the other.
The ordinary dashboard is unchanged. **Cyan marks redesigned elements** in
`atlas-test`; its header identifies the comparison window.

Both commands resolve the same existing legacy index by default; the preview
does not copy or migrate it. If you normally specify a config, pass the same
absolute path to both:

```sh
atlas --config /absolute/path/config.toml
atlas-test --config /absolute/path/config.toml
```

From this checkout, `bun run atlas-test` also starts the preview. The package
provides an `atlas-test` executable alongside `atlas`.

## Comparison controls

Agent-created conversations are hidden initially; press **g** to show or hide
them. Unknown-origin conversations remain visible, and technical subject matter
alone does not count as agent authorship.

Use the arrow keys or **j/k** to focus a conversation and **Enter** to open it.
Drag the edges between conversation, project, source, and last-active headers
to adjust adjacent columns. Sizes reset when the terminal window is resized.
On wide terminals, the focused conversation has a fixed preview on the right.
Press **Space** to show a preview on narrower terminals without wrapping every
result. Cyan labels and controls identify the new presentation; they do not mark
newly generated summaries or changed transcript content.

The preview is read-only: it does not start ingestion, generate summaries, or
change favorites. It is a dashboard-only entrypoint, not an alternate route for
maintenance commands. Topics use local cleanup and available cached summaries;
the preview identifies stored summaries separately from source titles. Improved
transcript processing, topic extraction, keywords, and newly generated summaries
are separate work. Missing configuration or database files are not created.

No terminal windows are opened automatically. Exit either dashboard normally;
the other window and the normal Atlas command are independent.
