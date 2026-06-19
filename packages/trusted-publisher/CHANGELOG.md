# trusted-publisher

## 0.1.3

### Patch Changes

- Handle npm trust browser authentication in interactive terminals, serialize trust checks to avoid
  concurrent challenges, and require an explicit trusted-publisher `--yes` flag before applying
  changes. Correctly parse npm 11's singleton trust response and current permission names so existing
  trusted publishers are never mistaken for missing configurations.
