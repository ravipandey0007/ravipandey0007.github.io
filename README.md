# ravipandey0007.github.io

Research notes on malware reverse engineering and OS internals across Windows, macOS/iOS, Linux, and Android. Built with Jekyll, hosted on GitHub Pages — no build step to run, GitHub builds it on every push to `main`.

Live at **https://ravipandey0007.github.io**

## Adding a new post

1. Create a file in `_posts/` named `YYYY-MM-DD-your-title.md`.
2. Front matter:

   ```yaml
   ---
   title: "Your Post Title"
   description: "One or two sentences — shows on the homepage card and in link previews."
   categories: [malware-reversing]   # one of: malware-reversing, windows, macos-ios, linux, android
   ---
   ```

3. Write the post in Markdown below the front matter. Standard GitHub-flavored Markdown works: headings (`##`), fenced code blocks with a language tag, tables, links.
4. Optional callout boxes (used for warnings, checkpoints, dead ends) — drop raw HTML directly in the Markdown:

   ```html
   <div class="callout warn" markdown="1">
   **Heads up.** Whatever the warning is.
   </div>
   ```

   Variants: `callout warn` (amber), `callout good` (green, e.g. a checkpoint), `callout dead` (red, e.g. an abandoned approach).

5. Commit and push to `main`. GitHub Pages rebuilds automatically within a minute or two — no local Jekyll install required, though `bundle exec jekyll serve` works locally too if you have Ruby installed (`Gemfile` is already set up for it).

## Adding a new category

Add an entry to `categories_list` in `_config.yml`, then create `categories/<slug>/index.html` with:

```yaml
---
layout: category
title: Category Name
category_slug: your-slug
description: One line describing the category.
permalink: /categories/your-slug/
---
```

## Structure

```
_config.yml          site config + the category list used by the nav
_layouts/            default / home / post / category templates
_includes/            head, header, footer, post-list partial
assets/css/main.css   the whole design system (light + dark, one token set)
_posts/               one Markdown file per post
categories/           one index page per category
```
