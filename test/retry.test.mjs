import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import retry from "../src/retry.ts";

function setup(t, { timeout = "90000", enabled = true, hasUI = true } = {}) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const handlers = new Map();
	const ctx = {
		hasUI,
		isIdle: () => false,
		abort: t.mock.fn(),
		ui: { setStatus: t.mock.fn(), notify: t.mock.fn() },
	};
	retry(
		{
			registerFlag() {},
			getFlag: () => timeout,
			on: (event, handler) => handlers.set(event, handler),
		},
		{ readRetryPolicy: () => ({ enabled, errors: [] }) },
	);
	const emit = (type, event = {}) => handlers.get(type)?.({ type, ...event }, ctx);
	emit("session_start");
	t.after(() => emit("session_shutdown"));
	return { ctx, emit, tick: (ms) => t.mock.timers.tick(ms) };
}

test("silent streams warn without cancelling the run or rewriting a user's abort", (t) => {
	const { ctx, emit, tick } = setup(t);
	emit("before_provider_request");
	tick(90000);
	assert.equal(ctx.abort.mock.callCount(), 0);
	assert.equal(ctx.ui.notify.mock.callCount(), 1);
	assert.match(ctx.ui.notify.mock.calls[0].arguments[0], /provider timeout/);
	assert.deepEqual(ctx.ui.setStatus.mock.calls.at(-1).arguments, ["retry", "stalled"]);
	assert.equal(
		emit("message_end", {
			message: { role: "assistant", stopReason: "aborted", errorMessage: "Request was aborted" },
		}),
		undefined,
	);
	tick(300000);
	assert.equal(ctx.ui.notify.mock.callCount(), 1);
	assert.equal(ctx.abort.mock.callCount(), 0);
});

test("raw provider activity resets the warning timer even without text deltas", (t) => {
	const { ctx, emit, tick } = setup(t);
	emit("before_provider_request");
	tick(80000);
	emit("provider_stream_event", { data: { type: "response.in_progress" } });
	tick(80000);
	assert.equal(ctx.ui.notify.mock.callCount(), 0);
	tick(10000);
	assert.equal(ctx.ui.notify.mock.callCount(), 1);
	emit("provider_stream_event", { data: { type: "response.in_progress" } });
	assert.deepEqual(ctx.ui.setStatus.mock.calls.at(-1).arguments, ["retry", "receiving"]);
	tick(80000);
	assert.equal(ctx.ui.notify.mock.callCount(), 1);
	assert.equal(ctx.abort.mock.callCount(), 0);
});

test("cache warming during parallel tools does not start a provider watchdog", (t) => {
	const { ctx, emit, tick } = setup(t);
	emit("tool_execution_start");
	emit("tool_execution_start");
	emit("tool_execution_end");
	emit("before_provider_request");
	tick(90000);
	assert.equal(ctx.ui.notify.mock.callCount(), 0);
	emit("tool_execution_end");
	emit("before_provider_request");
	tick(90000);
	assert.equal(ctx.ui.notify.mock.callCount(), 1);
	assert.equal(ctx.abort.mock.callCount(), 0);
});

test("retry-disabled policy disables stall warnings without cancelling", (t) => {
	const { ctx, emit, tick } = setup(t, { enabled: false });
	assert.equal(ctx.ui.notify.mock.callCount(), 1);
	emit("before_provider_request");
	tick(300000);
	assert.equal(ctx.ui.notify.mock.callCount(), 1);
	assert.equal(ctx.abort.mock.callCount(), 0);
});

for (const timeout of ["0", "off", "false"]) {
	test(`warning timeout ${timeout} disables the watchdog`, (t) => {
		const { ctx, emit, tick } = setup(t, { timeout });
		emit("before_provider_request");
		tick(300000);
		assert.equal(ctx.ui.notify.mock.callCount(), 0);
		assert.equal(ctx.abort.mock.callCount(), 0);
	});
}

test("headless requests never cancel and native timeout errors stay unchanged", (t) => {
	const { ctx, emit, tick } = setup(t, { hasUI: false });
	emit("before_provider_request");
	tick(300000);
	assert.equal(ctx.abort.mock.callCount(), 0);
	assert.equal(ctx.ui.notify.mock.callCount(), 0);
	assert.equal(
		emit("message_end", {
			message: { role: "assistant", stopReason: "error", errorMessage: "Request timed out." },
		}),
		undefined,
	);
});

test("completion and shutdown disarm stall warnings", (t) => {
	const { ctx, emit, tick } = setup(t);
	emit("before_provider_request");
	emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
	tick(90000);
	emit("before_provider_request");
	emit("session_shutdown");
	tick(90000);
	assert.equal(ctx.ui.notify.mock.callCount(), 0);
});

test("known provider failures still receive one retry hint", (t) => {
	const { ctx, emit } = setup(t);
	for (const errorMessage of [
		"Unknown error (no error details in response)",
		"websocket_connection_limit_reached",
		"Codex error: An error occurred while processing your request. You can retry your request",
	]) {
		const { message } = emit("message_end", {
			message: { role: "assistant", stopReason: "error", errorMessage },
		});
		assert.equal(message.stopReason, "error");
		assert.match(message.errorMessage, /provider returned error/);
		assert.equal(emit("message_end", { message }), undefined);
	}
	assert.equal(ctx.abort.mock.callCount(), 0);
});

test("Pi's native timeout still retries after a stall warning", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-retry-test-"));
	let session;
	try {
		const modelRuntime = await ModelRuntime.create({
			authPath: join(dir, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(dir, "models-cache.json"),
			refreshOnCreate: false,
		});
		let attempts = 0;
		modelRuntime.registerProvider("retry-test", {
			baseUrl: "http://unused.test",
			apiKey: "test-only",
			api: "retry-test",
			models: [
				{
					id: "test",
					name: "test",
					contextWindow: 4096,
					maxTokens: 256,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
			streamSimple(model, _context, options) {
				const failed = ++attempts === 1;
				const message = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
					content: failed ? [] : [{ type: "text", text: "recovered" }],
					stopReason: failed ? "error" : "stop",
					...(failed ? { errorMessage: "Request timed out." } : {}),
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
				return {
					async *[Symbol.asyncIterator]() {
						await options.onPayload?.({}, model);
						await options.onResponse?.({ status: 200, headers: {} }, model);
						yield { type: "start", partial: message };
						if (failed) await delay(10);
						yield failed
							? { type: "error", reason: "error", error: message }
							: { type: "done", reason: "stop", message };
					},
					async result() {
						return message;
					},
				};
			},
		});
		await modelRuntime.refresh({ allowNetwork: false });
		const settingsManager = SettingsManager.inMemory({
			cacheWarming: "off",
			compaction: { enabled: false },
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				(pi) =>
					retry(
						{ ...pi, getFlag: () => "1" },
						{ readRetryPolicy: () => ({ enabled: true, errors: [] }) },
					),
			],
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		({ session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			modelRuntime,
			model: modelRuntime.getModel("retry-test", "test"),
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(dir),
			tools: [],
		}));
		const warnings = [];
		const events = [];
		await session.bindExtensions({
			uiContext: { setStatus() {}, notify: (message) => warnings.push(message) },
			mode: "tui",
		});
		session.subscribe((event) => events.push(event));
		await session.prompt("test");
		assert.equal(attempts, 2);
		assert.equal(session.getLastAssistantText(), "recovered");
		assert.ok(warnings.some((message) => message.includes("provider timeout")));
		assert.ok(events.some((event) => event.type === "auto_retry_start"));
		assert.ok(events.some((event) => event.type === "auto_retry_end" && event.success));
	} finally {
		session?.dispose();
		await rm(dir, { recursive: true, force: true });
	}
});
