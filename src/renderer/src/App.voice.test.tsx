import type { VoiceModelStatus } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { App } from "./App";
import {
  emitAgentEvent,
  installOpenbotStub,
  installVoiceRecordingMocks,
  queuedDelivery,
  testServer,
} from "./app-test-harness";

describe("OpenBot connected desktop shell", () => {
  beforeEach(() => {
    installOpenbotStub();
  });

  it("explains blocked microphone access, then records and offers the send arrow", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(
      await screen.findByText("Microphone access is blocked. Allow OpenBot to use the microphone in system settings."),
    ).toBeInTheDocument();

    installVoiceRecordingMocks();
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: "turn-active",
        revision: 2,
        messages: [],
      },
    });
    await screen.findByRole("button", { name: "Stop agent" });

    await fireEvent.click(screen.getByRole("button", { name: "Create prompt with voice" }));

    const status = await screen.findByRole("group", { name: "Voice recording" });
    expect(within(status).getByText("0:00")).toBeVisible();
    expect(within(status).getByRole("button", { name: "Stop voice recording" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create prompt with voice" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send voice message" })).toBeInTheDocument();
  });

  it("downloads the voice model before it requests microphone access", async () => {
    let resolvePreparation: ((status: VoiceModelStatus) => void) | undefined;
    let reportModelStatus: ((status: VoiceModelStatus) => void) | undefined;
    vi.mocked(window.openbot.voice.prepareModel).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreparation = resolve;
        }),
    );
    vi.mocked(window.openbot.voice.onModelStatus).mockImplementationOnce((listener) => {
      reportModelStatus = listener;
      return () => undefined;
    });
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    reportModelStatus?.({ phase: "downloading", progress: 47, message: null });
    await waitFor(() => {
      expect(screen.getAllByRole("status").some((status) => status.textContent?.includes("47%"))).toBe(true);
    });

    resolvePreparation?.({ phase: "ready", progress: 100, message: null });
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce());
  });

  it("shows a deferred voice setup error in the original conversation", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let resolvePreparation: ((status: VoiceModelStatus) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    vi.mocked(window.openbot.voice.prepareModel).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreparation = resolve;
        }),
    );
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    await waitFor(() => expect(window.openbot.voice.prepareModel).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );

    resolvePreparation?.({ phase: "error", progress: 0, message: "Local voice setup failed" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create prompt with voice" })).toBeEnabled());
    expect(screen.queryByText("Local voice setup failed")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));
    expect(await screen.findByText("Local voice setup failed")).toBeInTheDocument();
  });

  it("does not open the microphone for a conversation the user has left", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let resolvePreparation: ((status: VoiceModelStatus) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    vi.mocked(window.openbot.voice.prepareModel).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreparation = resolve;
        }),
    );
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    await waitFor(() => expect(window.openbot.voice.prepareModel).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );

    resolvePreparation?.({ phase: "ready", progress: 100, message: null });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create prompt with voice" })).toBeEnabled());
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("stops offering a recording the user walked away from", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let resolveTranscription: ((result: { text: string }) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    vi.mocked(window.openbot.voice.transcribe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    installVoiceRecordingMocks();
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() => expect(window.openbot.voice.transcribe).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));

    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    expect(composer).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: "Stop voice recording" })).not.toBeInTheDocument();

    resolveTranscription?.({ text: "Walked away" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create prompt with voice" })).toBeEnabled());
  });

  it("submits the accepted voice snapshot and preserves later draft changes", async () => {
    let resolveTranscription: ((result: { text: string }) => void) | undefined;
    vi.mocked(window.openbot.voice.transcribe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    installVoiceRecordingMocks();
    render(() => <App />);

    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Existing draft";
    await fireEvent.input(composer);
    await fireEvent.click(screen.getByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(window.openbot.voice.transcribe).toHaveBeenCalledOnce());

    expect(composer).toHaveAttribute("aria-disabled", "true");
    await fireEvent.keyDown(composer, { key: "Enter" });
    expect(window.openbot.agent.sendMessage).not.toHaveBeenCalled();
    composer.textContent = "Later draft";
    await fireEvent.input(composer);

    resolveTranscription?.({ text: "Voice transcript" });
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith(
        { botId: "chief", text: "Existing draft Voice transcript", attachmentDraftIds: [] },
        "local",
      ),
    );
    expect(window.openbot.agent.sendMessage).toHaveBeenCalledOnce();
    await waitFor(() => expect(composer).toHaveTextContent("Later draft"));
  });

  it("keeps a deferred transcript and its failure with the chat that started them", async () => {
    let resolveTranscription: ((result: { text: string }) => void) | undefined;
    let rejectTranscription: ((error: Error) => void) | undefined;
    vi.mocked(window.openbot.voice.transcribe)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveTranscription = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectTranscription = reject;
          }),
      );
    installVoiceRecordingMocks();
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    const recording = await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(within(recording).getByRole("button", { name: "Stop voice recording" }));
    await waitFor(() => expect(window.openbot.voice.transcribe).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));

    resolveTranscription?.({ text: "Draft for Chief" });
    await screen.findByRole("button", { name: "Create prompt with voice" });
    expect(window.openbot.agent.sendMessage).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Message Chief" })).toHaveTextContent("Draft for Chief"),
    );

    await fireEvent.click(screen.getByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(window.openbot.voice.transcribe).toHaveBeenCalledTimes(2));
    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));

    rejectTranscription?.(new Error("Transcription failed"));
    await screen.findByRole("button", { name: "Create prompt with voice" });
    expect(screen.queryByText("Transcription failed")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Transcription failed");
    await fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.queryByText("Transcription failed")).not.toBeInTheDocument());
  });

  it("finishes an accepted voice send on the original server after the server changes", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let resolveTranscription: ((result: { text: string }) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    vi.mocked(window.openbot.voice.transcribe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    installVoiceRecordingMocks();
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(window.openbot.voice.transcribe).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );

    resolveTranscription?.({ text: "Message for local Chief" });
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith(
        {
          botId: "chief",
          text: "Message for local Chief",
          attachmentDraftIds: [],
        },
        "local",
      ),
    );
  });

  it("shows a deferred send error on the original server", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let resolveTranscription: ((result: { text: string }) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    vi.mocked(window.openbot.voice.transcribe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    vi.mocked(window.openbot.agent.sendMessage).mockRejectedValueOnce(new Error("Local send failed"));
    installVoiceRecordingMocks();
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(window.openbot.voice.transcribe).toHaveBeenCalledOnce());
    const composer = screen.getByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Later local draft";
    await fireEvent.input(composer);
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );

    resolveTranscription?.({ text: "Message for local Chief" });
    await waitFor(() => expect(window.openbot.agent.sendMessage).toHaveBeenCalledOnce());
    expect(screen.queryByText("Local send failed")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));
    expect(await screen.findByText("Local send failed")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Chief" })).toHaveTextContent(
      "Later local draft Message for local Chief",
    );
  });

  it("saves a queued-message edit on its original server after the server changes", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let resolveTranscription: ((result: { text: string }) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    vi.mocked(window.openbot.voice.transcribe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    installVoiceRecordingMocks();
    vi.mocked(window.openbot.agent.listQueue).mockResolvedValueOnce({
      botId: "chief",
      deliveries: [
        queuedDelivery("delivery-running", "Running", null, { status: "running", turnId: "turn-running" }),
        queuedDelivery("delivery-voice-edit", "Queued draft", 1),
      ],
    });
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(await screen.findByRole("button", { name: "Edit queued message 1" }));
    await fireEvent.click(screen.getByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Save queued message" }));
    await waitFor(() => expect(window.openbot.voice.transcribe).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.queryByRole("button", { name: "Save queued message" })).not.toBeInTheDocument();

    resolveTranscription?.({ text: "Voice transcript" });
    await waitFor(() =>
      expect(window.openbot.agent.updateQueuedMessage).toHaveBeenCalledWith(
        {
          botId: "chief",
          deliveryId: "delivery-voice-edit",
          text: "Queued draft Voice transcript",
          keepAttachmentIds: [],
          attachmentDraftIds: [],
        },
        "local",
      ),
    );
    expect(window.openbot.agent.sendMessage).not.toHaveBeenCalled();
  });

  it("retains a queued-message edit only in its original conversation", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    vi.mocked(window.openbot.agent.listQueue).mockResolvedValueOnce({
      botId: "chief",
      deliveries: [
        queuedDelivery("delivery-running", "Running", null, { status: "running", turnId: "turn-running" }),
        queuedDelivery("delivery-edit", "Queued draft", 1),
      ],
    });
    render(() => <App />);

    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Personal draft";
    await fireEvent.input(composer);
    await fireEvent.click(await screen.findByRole("button", { name: "Edit queued message 1" }));
    expect(composer).toHaveTextContent("Queued draft");

    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.queryByRole("button", { name: "Save queued message" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));
    await screen.findByRole("button", { name: "Save queued message" });
    expect(screen.getByRole("textbox", { name: "Message Chief" })).toHaveTextContent("Queued draft");

    await fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("textbox", { name: "Message Chief" })).toHaveTextContent("Personal draft");
    expect(window.openbot.agent.updateQueuedMessage).not.toHaveBeenCalled();
  });
});
