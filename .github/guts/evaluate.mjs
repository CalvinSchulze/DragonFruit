#!/usr/bin/env node
// Score Jev against the hand-labelled issues in labelled.json. See
// docs/dev/issue-guts-tuning.md for the procedure this belongs to.
//
//   node .github/guts/evaluate.mjs [--split train|holdout|all] [--threshold 0.7]
//                                      [--save run.json | --run run.json]
//
// Without --run it classifies every issue in the split (TYPESAFE_API_KEY and
// GITHUB_TOKEN needed, about $0.0001 per issue); --save keeps those answers so
// the scoring can be redone, at any threshold, without asking Jev again.

import {readFileSync, writeFileSync} from 'node:fs'
import {parseArgs} from 'node:util'
import {areas, classify, fetchIssue, pickAreas, DEFAULT_THRESHOLD} from './classify.mjs'

const SWEEP = [0.5, 0.6, 0.7, 0.8, 0.9]
// Answers this close to the threshold can flip between two identical runs.
const FRAGILE_MARGIN = 0.05

const {values} = parseArgs({
  options: {
    split: {type: 'string', default: 'train'},
    threshold: {type: 'string', default: String(DEFAULT_THRESHOLD)},
    run: {type: 'string'},
    save: {type: 'string'},
  },
})
const threshold = Number(values.threshold)

const labelled = JSON.parse(readFileSync(new URL('labelled.json', import.meta.url), 'utf8'))
const cases = Object.entries(labelled).filter(([, c]) => values.split === 'all' || c.split === values.split)
if (cases.length === 0) throw new Error(`no labelled issues in split "${values.split}"`)

for (const [n, c] of cases) {
  const unknown = c.areas.filter(area => !(area in areas))
  if (unknown.length) throw new Error(`#${n} is labelled with unknown areas: ${unknown.join(', ')}`)
}

let run = values.run ? JSON.parse(readFileSync(values.run, 'utf8')) : {}
if (!values.run) {
  let cost = 0
  for (const [n] of cases) {
    const issue = await fetchIssue(Number(n))
    const result = await classify(issue)
    run[n] = {title: issue.title, model: result.model, probabilities: result.probabilities}
    cost += result.cost ?? 0
    process.stderr.write('.')
  }
  process.stderr.write(` ${cases.length} issues, $${cost.toFixed(4)}\n`)
  if (values.save) writeFileSync(values.save, JSON.stringify(run, null, 2) + '\n')
}

function score(t) {
  let tp = 0, fp = 0, fn = 0, exact = 0
  const perArea = {}
  const errors = []
  for (const [n, c] of cases) {
    const p = run[n]?.probabilities
    if (!p) throw new Error(`#${n} has no answer in the run`)
    // A run made before an area existed has no probability for it.
    const got = pickAreas(Object.fromEntries(Object.keys(areas).map(a => [a, p[a] ?? 0])), t)
    const missed = c.areas.filter(a => !got.includes(a))
    const extra = got.filter(a => !c.areas.includes(a))
    tp += c.areas.length - missed.length
    fn += missed.length
    fp += extra.length
    if (!missed.length && !extra.length) exact++
    for (const a of missed) (perArea[a] ??= {missed: 0, extra: 0}).missed++
    for (const a of extra) (perArea[a] ??= {missed: 0, extra: 0}).extra++
    if (missed.length || extra.length) errors.push({n, title: c.title, missed, extra, p})
  }
  const precision = tp / (tp + fp)
  const recall = tp / (tp + fn)
  return {exact, precision, recall, f1: (2 * precision * recall) / (precision + recall), perArea, errors}
}

const pct = x => x.toFixed(2)
console.log(`split ${values.split}: ${cases.length} issues, ${Object.values(run)[0]?.model ?? '?'}\n`)
console.log('threshold  exact   precision  recall  F1')
for (const t of [...new Set([...SWEEP, threshold])].sort()) {
  const s = score(t)
  const mark = t === threshold ? '←' : ''
  console.log(`  ${t.toFixed(2)}     ${String(s.exact).padStart(2)}/${cases.length}   ${pct(s.precision)}       ${pct(s.recall)}    ${pct(s.f1)} ${mark}`)
}

const s = score(threshold)
console.log(`\nAt ${threshold}:`)
const fmt = (p, a) => `${a} ${(p[a] ?? 0).toFixed(2)}`
for (const e of s.errors) {
  console.log(`  #${e.n} ${e.title.slice(0, 70)}`)
  if (e.missed.length) console.log(`      missed: ${e.missed.map(a => fmt(e.p, a)).join(', ')}`)
  if (e.extra.length) console.log(`      extra:  ${e.extra.map(a => fmt(e.p, a)).join(', ')}`)
}
console.log('\nErrors per area:')
for (const [a, {missed, extra}] of Object.entries(s.perArea).sort(([, x], [, y]) => y.missed + y.extra - x.missed - x.extra)) {
  console.log(`  ${a.padEnd(26)} missed ${missed}, extra ${extra}`)
}

const fragile = cases.flatMap(([n]) =>
  Object.entries(run[n].probabilities)
    .filter(([, p]) => Math.abs(p - threshold) < FRAGILE_MARGIN)
    .map(([a, p]) => `#${n} ${a} ${p.toFixed(2)}`),
)
console.log(`\nWithin ${FRAGILE_MARGIN} of the threshold (may flip between runs): ${fragile.join(', ') || 'none'}`)
