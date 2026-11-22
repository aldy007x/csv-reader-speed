[![csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/aldy007x/csv-reader-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/aldy007x/csv-reader-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

# csv-reader-speed

A faster drop-in for make.fun's own **csv-reader 1.0.0**: it reads broken CSV files and answers exactly as csv-reader does on every case — `{columns, rows, errors}` for each `{text, header}` — in a fraction of the CPU time.

Entry for the [make.fun bounty "Read broken CSV files faster, 21 November 2026"](https://make.fun/bounty/csv-reader-speed-01-run-20261121).

## How it is fast

The reference reads one character at a time and builds every field by appending one character at a time. This reader works on slices between delimiters, each found with one native scan:

- **Whole-line fast path:** a line with no quote and no stray CR is found with one `indexOf`, checked with one short regex scan, and split on `,` by native code.
- **Plain runs:** a line that does hold a quote or a stray CR is read in plain runs — each run is the text up to the next quote, CR or LF, split on `,` by native code, so its plain fields come out whole. Only a field that actually opens with a quote, or the junk after one, is read field by field.
- **Quoted fields** are one slice up to the next quote (with `""` → `"` and CRLF / lone CR inside read as LF), not a character loop.

Nothing is cached from one case to the next, and nothing is kept between calls.

## Correctness

Every rule of csv-reader 1.0.0 is followed: a U+FEFF at the very start is dropped; records end at LF or CRLF and empty lines are no records; a CR outside quotes not followed by LF is dropped (`stray_cr`); a field opening with a quote runs to the next non-doubled quote, junk after its closing quote is appended as it stands (`quote_junk`), and a quote that never closes is a literal with the text after it re-read as unquoted (`unterminated_quote`); rows are padded or cut to the first record's width (`short_row` / `long_row`); errors carry the line the record starts on and its index in rows.

Verified against the reference: **6/6 practice cases identical**, plus thousands of adversarial fuzz cases and generator-drawn sets, all identical to csv-reader 1.0.0.

## Speed

On the kit's practice set (6 cases, 10.2M characters of CSV), measured CPU time:

| | solve() only | whole program |
|---|---:|---:|
| csv-reader 1.0.0 (house baseline) | ~725 ms | ~1.74 s |
| this entry | ~154 ms | ~1.08 s |

About **4.7× faster** on the parsing itself, **~1.6× faster** end to end (the rest is the JSON input/output the two entries share).

## Run it

Node 22, standard library only:

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<cases dir> MAKEFUN_OUTPUT_DIR=out node main.ts
```

This writes `out/answers.json`, one answer per case in the cases' order. Run it twice and the two files are byte-identical.

## Files

- `solve.js` — the reader: `run(input)` returns csv-reader 1.0.0's answer for `{text, header}`.
- `main.ts` — the driver: reads `/input/cases.json`, answers each case with `run`, writes `/output/answers.json`. It leaves V8's incremental marking on: this reader builds its answers from flat slices, not from chains of joined strings, and measured on the practice set it runs faster with the default flags than with `--no-incremental-marking`.
- `package.json` — `{ "type": "module" }`.
