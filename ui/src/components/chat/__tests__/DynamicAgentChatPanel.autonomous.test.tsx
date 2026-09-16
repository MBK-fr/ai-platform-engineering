import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatMessage, Conversation } from "@/types/a2a";
import { ChatPanel } from "../DynamicAgentChatPanel";

let mockConversation: Conversation;
const mockFollowUpRun = jest.fn();
const mockToast = jest.fn();
const mockStreamMessage = jest.fn().mockResolvedValue(undefined);
const mockChatState = {
  activeConversationId: "task-chat",
  getActiveConversation: () => mockConversation,
  get conversations() { return [mockConversation]; },
  isConversationStreaming: () => false,
  consumePendingMessage: () => null,
  addMessage: jest.fn(() => "typed-message"),
  updateMessage: jest.fn(),
  appendToMessage: jest.fn(),
  clearStreamEvents: jest.fn(),
  setConversationStreaming: jest.fn(),
  loadMessagesFromServer: jest.fn(),
};

jest.mock("@/store/chat-store", () => ({
  useChatStore: Object.assign(() => mockChatState, { getState: () => mockChatState }),
}));
jest.mock("@/store/feature-flag-store", () => ({
  useFeatureFlagStore: (selector: (state: unknown) => unknown) => selector({ flags: { autoScroll: false } }),
}));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: null }) }));
jest.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: mockToast }) }));
jest.mock("@/lib/config", () => ({ getConfig: (key: string) => key === "appName" ? "Test agent" : false }));
jest.mock("@/components/autonomous/api", () => ({
  autonomousApi: {
    followUpRun: (...args: unknown[]) => mockFollowUpRun(...args),
    listRuns: async () => [],
  },
}));
jest.mock("@/lib/streaming", () => ({
  createStreamAdapter: () => ({ streamMessage: mockStreamMessage, abort: jest.fn() }),
}));
jest.mock("@/hooks/useDynamicAgentTimeline", () => ({ useAgentTimeline: () => ({ data: {} }) }));
jest.mock("@/components/shared/timeline", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));
jest.mock("@/components/dynamic-agents/AgentAvatar", () => ({ AgentAvatar: () => null }));
jest.mock("../DynamicAgentTimeline", () => ({ AgentTimeline: () => null }));
jest.mock("../FeedbackButton", () => ({ FeedbackButton: () => null }));
jest.mock("../useSlashCommands", () => ({ useSlashCommands: () => [] }));
jest.mock("../CustomCallButtons", () => ({ DEFAULT_AGENTS: [] }));

function runMessages(runId: string): ChatMessage[] {
  return (["user", "assistant"] as const).map((role) => ({
    id: `${runId}-${role}`,
    role,
    content: `${runId} ${role}`,
    timestamp: new Date("2026-09-01T10:00:00Z"),
    turnId: runId,
    autonomousRunId: runId,
    autonomousExecutionContextId: `${runId}-context`,
    autonomousMessageKind: role === "assistant" ? "run_response" : "run_request",
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  HTMLElement.prototype.scrollIntoView = jest.fn();
  mockConversation = {
    id: "task-chat",
    title: "Example task",
    source: "autonomous",
    task_id: "example-task",
    messages: [...runMessages("older"), ...runMessages("latest")],
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Conversation;
  mockFollowUpRun.mockResolvedValue({ run_id: "older-reply" });
});

it("offers exact continuation only for the older run and keeps the normal composer", async () => {
  render(<ChatPanel agentId="example-agent" conversationId="task-chat" />);
  expect(screen.getAllByRole("button", { name: "Continue this run" })).toHaveLength(1);
  expect(screen.getByPlaceholderText(/Ask anything/)).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Continue this run" }));
  fireEvent.change(screen.getByPlaceholderText(/using only this run's context/), {
    target: { value: "Explain the older result" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send follow-up" }));
  await waitFor(() => expect(mockFollowUpRun).toHaveBeenCalledWith("example-task", "older", "Explain the older result"));
});

it("sends a latest-run reply through the normal chat stream", async () => {
  render(<ChatPanel agentId="example-agent" conversationId="task-chat" />);
  fireEvent.change(screen.getByPlaceholderText(/Ask anything/), { target: { value: "Explain the latest result" } });
  fireEvent.click(screen.getByTitle("Send message"));
  await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledWith(
    expect.objectContaining({ conversationId: "task-chat", message: "Explain the latest result" }),
    expect.any(Object),
  ));
  expect(mockFollowUpRun).not.toHaveBeenCalled();
});

it("keeps the latest run button hidden after ordinary user follow-ups", () => {
  mockConversation.messages.push(
    { id: "typed-user", role: "user", content: "More details?", timestamp: new Date(), turnId: "typed" },
    { id: "typed-answer", role: "assistant", content: "More details.", timestamp: new Date(), turnId: "typed" },
  );
  render(<ChatPanel agentId="example-agent" conversationId="task-chat" />);
  expect(screen.getAllByRole("button", { name: "Continue this run" })).toHaveLength(1);
});

it("makes a previous run continuable when a newer run arrives", () => {
  const { rerender } = render(<ChatPanel agentId="example-agent" conversationId="task-chat" />);
  mockConversation = { ...mockConversation, messages: [...mockConversation.messages, ...runMessages("newest")] };
  rerender(<ChatPanel agentId="example-agent" conversationId="task-chat" />);
  expect(screen.getAllByRole("button", { name: "Continue this run" })).toHaveLength(2);
});

it("does not offer continuation in a read-only conversation", () => {
  render(<ChatPanel agentId="example-agent" conversationId="task-chat" readOnly readOnlyReason="shared_readonly" />);
  expect(screen.queryByRole("button", { name: "Continue this run" })).toBeNull();
  expect(screen.queryByPlaceholderText(/Ask anything/)).toBeNull();
});
