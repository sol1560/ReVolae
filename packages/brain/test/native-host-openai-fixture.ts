interface FixtureMessage {
  role?: string;
  content?: string | { text?: string }[];
}

interface ChatRequest {
  messages?: FixtureMessage[];
  tool_choice?: string | { function?: { name?: string } };
}

interface RecordedRequest {
  scenario: string;
  step: number;
  messages: FixtureMessage[];
}

const requests: RecordedRequest[] = [];
const requestCounts = new Map<string, number>();
const port = Number(process.argv[2]);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("expected a TCP port as the first argument");
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/state") {
      const planCalls: Record<string, number> = {};
      for (const item of requests) {
        if (item.step === 1) planCalls[item.scenario] = (planCalls[item.scenario] ?? 0) + 1;
      }
      const toolResults = requests.flatMap((item) =>
        item.messages
          .filter((message) => message.role === "tool")
          .map((message) => typeof message.content === "string" ? message.content : ""),
      );
      return Response.json({ planCalls, toolResults, requestCount: requests.length });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      return new Response("not found", { status: 404 });
    }

    const body = await request.json() as ChatRequest;
    const messages = body.messages ?? [];
    const userText = messages
      .filter((message) => message.role === "user")
      .map((message) => typeof message.content === "string"
        ? message.content
        : (message.content ?? []).map((part) => part.text ?? "").join("\n"))
      .join("\n");
    const scenario = /scenario:([a-z-]+)/.exec(userText)?.[1];
    const workspace = /workspace=([^\s]+)/.exec(userText)?.[1];
    if (!scenario || !workspace) return Response.json({ error: "missing test scenario" }, { status: 400 });

    const step = (requestCounts.get(scenario) ?? 0) + 1;
    requestCounts.set(scenario, step);
    requests.push({ scenario, step, messages });

    if (step === 1 && forceTool(body.tool_choice) === "propose_plan") {
      return toolResponse(`plan-${scenario}`, "propose_plan", {
        steps: [
          { title: "Read the scoped integration fixture", channel: "fs" },
          { title: "Write the approved integration fixture", channel: "shell" },
        ],
      });
    }
    if (step === 2) {
      return toolResponse(`read-${scenario}`, "fs.read", { path: `${workspace}/input.txt`, maxBytes: 65_536 });
    }
    if (step === 3) {
      return toolResponse(`write-${scenario}`, "shell.run", {
        cmd: `printf ${scenario} > ${scenario}.txt`,
        cwd: workspace,
      });
    }
    return Response.json({
      id: `done-${scenario}`,
      object: "chat.completion",
      created: 1,
      model: "local-fixture",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "fixture task complete" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  },
});

process.stdout.write("ready\n");

function forceTool(choice: ChatRequest["tool_choice"]): string | undefined {
  return typeof choice === "object" ? choice.function?.name : undefined;
}

function toolResponse(id: string, name: string, args: Record<string, unknown>) {
  return Response.json({
    id,
    object: "chat.completion",
    created: 1,
    model: "local-fixture",
    choices: [{
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}
