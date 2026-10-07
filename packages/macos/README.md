# CuaRemoteMac

`CuaRemoteMac` is a non-UI macOS 15 daemon package built on `CuaRemoteCore` and `CuaRemoteProtocol`. It starts one Brain native host child per accepted task and keeps provider and credential configuration local.

```swift
import CuaRemoteCore
import CuaRemoteMac

let client = try RemoteClient(role: .device, name: "Mac")
let configuration = try MacDaemonConfiguration(
    repoURL: repoURL,
    bunURL: bunURL,
    workspaceURL: workspaceURL,
    provider: "anthropic:claude",
    modelCredentialEnvironment: ["ANTHROPIC_API_KEY": locallySuppliedKey]
)
let daemon = try MacDaemon(client: client, configuration: configuration)
try await daemon.connect(to: hubURL, token: token)
```

Build and run the package tests with:

```sh
swift test --package-path packages/macos
```

## Public API

- `MacDaemon.init(client:configuration:journalURL:)` requires a device-role `RemoteClient`.
- `MacDaemon.client`, `configuration`, `state`, `currentRun`, and `history` are read-only observable state.
- `MacDaemon.connect(to:token:allowInsecureLocalDevelopment:)`, `disconnect()`, and `stopCurrentRun()` control the lifecycle.
- `MacDaemonConfiguration.init(repoURL:bunURL:workspaceURL:provider:modelCredentialEnvironment:)` supplies local paths, model provider, and locally supplied credential variables.
- `MacDaemon.executionAuthorityNotice` is the user-facing warning for command tools.
- `MacRunRecord` and `MacRunStatus` describe the durable run history.

The daemon accepts only a paired, ready owner’s `intent.submit` for the local device in `agent` mode, owner `run.cancel`, signed `approval.decision`, and `history.list`. Phone-supplied provider, privacy settings, tools, and host responses are never forwarded. The Brain child receives only locally selected provider configuration and accepted task/approval messages. One task can run at a time; repeated owner/submit IDs return their journaled state without another spawn.

The journal is stored under Application Support with restrictive directory/file permissions and atomic replacement. Active records are marked `interrupted, effects may remain` on restart; work is never resumed automatically. Transport/peer loss or local stop kills the process group with SIGTERM then SIGKILL and clears approvals/grants. Killing a process cannot undo effects or promises made to separately detached processes.

## Tools and authority

- `fs.read` and `fs.list` canonicalize symlinks and reject paths outside the selected workspace. Reads, list depth, entry count, and protocol output are bounded.
- `shell.run`, `applescript.run`, and `shortcuts.run` are always static level 2 and require a signed, single-use approval bound to the active run and exact action detail/target path. Unsupported arguments are rejected.
- Shell commands and scripts execute with the logged-in user’s full account authority. The workspace is a working directory, **not** a sandbox. Shell uses `/bin/sh -c`; AppleScript uses `/usr/bin/osascript -e` with the script as a literal argument; Shortcuts uses `/usr/bin/shortcuts run` with the literal name.
- A first GUI scenario can use explicitly approved AppleScript/System Events only after the user grants the required Automation and Accessibility permissions. There is no automatic or blind CUA fallback.

Brain stdout is JSONL protocol only. Each line is limited to 1 MiB; child stdout and stderr are bounded, and stderr is not logged. Tool results are returned only to the current Brain child. The daemon contains no UI and its tests do not constitute acceptance of a real model/provider.

The phone-side `ApprovalSigning` helper validates the request and signs/verifies ES256 approval-v1 decisions. It does **not** perform biometric authentication; the phone UI must use `LAContext` before authorizing an allow decision.
