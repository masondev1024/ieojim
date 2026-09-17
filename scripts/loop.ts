#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LoopController, type LoopState, type ReviewVerdict } from './loop/controller';

type ParsedArgs = {
  command: string;
  plan?: string;
  id?: string;
  task?: string;
  verdict?: ReviewVerdict;
  reviewer?: string;
  executor?: string;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const controller = new LoopController({ root: process.cwd() });
  if (args.command === 'init') {
    if (!args.plan) throw new Error('init requires --plan <json>');
    const state = await controller.init(args.plan);
    print({ ok: true, state: publicState(state), nextAction: controller.nextAction(state) });
    return;
  }

  if (!args.id) throw new Error('pass --id <slug>; this controller has no active global singleton');
  const id = args.id;
  if (args.command === 'status') {
    const result = await controller.status(id);
    print({ ok: true, state: publicState(result.state), nextAction: result.action });
  } else if (args.command === 'next') {
    const result = await controller.next(id, args.executor ?? process.env.USER ?? 'unknown-executor');
    print({ ok: true, state: publicState(result.state), nextAction: result.action });
  } else if (args.command === 'verify') {
    const result = await controller.verify(id);
    print({ ok: result.ok, summary: result.summary, state: publicState(result.state), nextAction: controller.nextAction(result.state) });
    if (!result.ok) process.exitCode = 1;
  } else if (args.command === 'review') {
    if (!args.task) throw new Error('review requires --task <id>');
    if (!args.verdict) throw new Error('review requires --verdict approve|reject');
    if (!args.reviewer) throw new Error('review requires --reviewer <id>');
    const result = await controller.review(id, args.task, args.verdict, args.reviewer);
    print({ ok: result.state.phase !== 'halted', accepted: result.accepted, state: publicState(result.state), nextAction: controller.nextAction(result.state) });
    if (result.state.phase === 'halted') process.exitCode = 1;
  } else if (args.command === 'recover') {
    const state = await controller.recover(id);
    print({ ok: state.phase !== 'halted', state: publicState(state), nextAction: controller.nextAction(state) });
    if (state.phase === 'halted') process.exitCode = 1;
  } else {
    throw new Error('usage: loop init --plan <json> | status --id <slug> | next --id <slug> [--executor <id>] | verify --id <slug> | review --id <slug> --task <id> --verdict approve|reject --reviewer <id> | recover --id <slug>');
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? '';
  const parsed: ParsedArgs = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--plan' && next) {
      parsed.plan = next;
      index += 1;
    } else if (arg === '--id' && next) {
      parsed.id = next;
      index += 1;
    } else if (arg === '--task' && next) {
      parsed.task = next;
      index += 1;
    } else if (arg === '--verdict' && (next === 'approve' || next === 'reject')) {
      parsed.verdict = next;
      index += 1;
    } else if (arg === '--reviewer' && next) {
      parsed.reviewer = next;
      index += 1;
    } else if (arg === '--executor' && next) {
      parsed.executor = next;
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument ${arg}`);
    }
  }
  return parsed;
}

function publicState(state: LoopState) {
  return {
    id: state.manifest.id,
    objective: state.manifest.objective,
    phase: state.phase,
    haltedReason: state.haltedReason,
    tasks: Object.fromEntries(Object.entries(state.tasks).map(([id, task]) => [id, {
      status: task.status,
      attempts: task.attempts,
      executor: task.executor,
      lastAttempt: task.lastAttempt ? {
        attempt: task.lastAttempt.attempt,
        executor: task.lastAttempt.executor,
        baseFingerprint: task.lastAttempt.baseFingerprint,
        beforeGateFingerprint: task.lastAttempt.beforeGateFingerprint,
        afterGateFingerprint: task.lastAttempt.afterGateFingerprint,
        gate: task.lastAttempt.gate,
        review: task.lastAttempt.review,
      } : undefined,
      attemptReceipts: task.attemptReceipts.map((attempt) => ({
        attempt: attempt.attempt,
        executor: attempt.executor,
        baseFingerprint: attempt.baseFingerprint,
        beforeGateFingerprint: attempt.beforeGateFingerprint,
        afterGateFingerprint: attempt.afterGateFingerprint,
        gate: attempt.gate,
        review: attempt.review,
      })),
    }])),
    updatedAt: state.updatedAt,
  };
}

function print(payload: unknown) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
