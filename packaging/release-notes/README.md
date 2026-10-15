# Release notes

One file per version, named after it without the `v`: `1.2.0.md` for the tag
`v1.2.0`. The release workflow puts the file at the top of the GitHub release,
above the changelog GitHub generates from pull request titles. A version with
no file is released with the generated changelog alone.

The console shows these notes on its "new version" card. Pull requests are
written in English, so the file carries a Vietnamese section as well, and a
console read in Vietnamese shows that instead. Without one it shows the
English.

## Format

English first. The Vietnamese goes between the two markers, which GitHub does
not render; the `<details>` fold shows it on the release page under a heading
of its own, and the console drops the fold and the heading.

```markdown
Short paragraph on what changed for the person using it.

- One line per change worth knowing about.
- Another.

<!-- stm:notes:vi -->
<details>
<summary>Tiếng Việt</summary>

Một đoạn ngắn về những gì thay đổi với người dùng.

- Mỗi thay đổi đáng biết một dòng.
- Dòng khác.

</details>
<!-- /stm:notes:vi -->
```

The console shows about 1,200 characters of each language and links to the
release page for the rest, so the most useful lines go first.
