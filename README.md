# pi-setup

My setup for the [pi](https://pi.dev) coding agent, as one pi package.

## Layout

- `extensions/`: pi extensions (TypeScript, loaded by pi without a build step)
- `skills/`: skills, one folder per skill with a `SKILL.md`
- `prompts/`: prompt templates

## Use

```sh
pnpm install
pi install ~/Projects/pi-setup
```

Try a change for one run without installing: `pi -e ~/Projects/pi-setup`.

## Check

```sh
pnpm check
```
