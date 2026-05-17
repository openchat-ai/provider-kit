# Contributing to @openchat/provider-kit

## Adding a new provider

1. Add adapter file in `src/providers/`
2. Export from `src/index.js`
3. Add preset config in `openai-compatible.js` PRESET_PROVIDERS
4. Write tests in `test/`
5. Run `npm test`

## Commit format

```
type: description

type: feat / fix / refactor / test / docs / chore
```

## Before submitting

- `npm test` passes
- `npm audit` passes
- `npm pack --dry-run` looks right
