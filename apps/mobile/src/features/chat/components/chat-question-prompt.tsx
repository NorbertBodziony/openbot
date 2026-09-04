import type { ConversationQuestionPrompt } from "@openbot/contracts/ipc";
import { Button, Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react-native";
import { View } from "react-native";
import type { QuestionPromptController } from "@/features/chat/components/use-question-prompt";
import { promptAnswerLabel } from "@/features/chat/model/question-prompt";

export function ChatQuestionPrompt({
  prompt,
  controller,
  canSend,
}: {
  prompt: ConversationQuestionPrompt;
  controller?: QuestionPromptController;
  canSend: boolean;
}) {
  const muted = useThemeColor("muted");
  const resolution =
    prompt.resolution ?? controller?.resolution ?? (controller ? null : { status: "expired" as const });
  if (resolution) {
    return (
      <View className="gap-3 rounded-[26px] bg-control/60 p-4">
        <View className="flex-row items-center gap-2">
          {resolution.status === "answered" ? <Check color={String(muted)} size={18} /> : null}
          <Typography weight="semibold">
            {resolution.status === "answered"
              ? "Answers sent"
              : resolution.status === "cancelled"
                ? "Form cancelled"
                : "Form expired"}
          </Typography>
        </View>
        {resolution.status === "answered"
          ? prompt.questions.map((item) => (
              <View key={item.id} className="gap-1">
                <Typography type="body-sm" className="text-text-secondary">
                  {item.question}
                </Typography>
                <Typography>{promptAnswerLabel(item, resolution)}</Typography>
              </View>
            ))
          : null}
      </View>
    );
  }

  if (!controller?.question) return null;
  const { question, index, disabled, pending, failedAnswers, setIndex, answer, submit } = controller;

  return (
    <View className="gap-2 rounded-[26px] bg-control/60 p-4" accessibilityLabel="Question form">
      <View className="flex-row items-center gap-2">
        <Typography weight="semibold" className="min-w-0 flex-1">
          {question.question}
        </Typography>
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          accessibilityLabel="Cancel form"
          isDisabled={disabled}
          onPress={() => void submit({})}
        >
          <X color={String(muted)} size={18} />
        </Button>
      </View>
      {prompt.questions.length > 1 ? (
        <View className="flex-row items-center justify-between">
          <Typography type="body-xs" className="flex-1 text-text-secondary">
            {index + 1} of {prompt.questions.length}
          </Typography>
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            accessibilityLabel="Previous question"
            isDisabled={disabled || index === 0}
            onPress={() => setIndex(index - 1)}
          >
            <ChevronLeft color={String(muted)} size={18} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            accessibilityLabel="Next question"
            isDisabled={disabled || index === prompt.questions.length - 1}
            onPress={() => setIndex(index + 1)}
          >
            <ChevronRight color={String(muted)} size={18} />
          </Button>
        </View>
      ) : null}
      <View>
        {question.options?.map((option, optionIndex) => (
          <Button
            key={option.label}
            variant="ghost"
            isDisabled={disabled}
            accessibilityLabel={option.label}
            className="h-auto min-h-12 justify-start rounded-xl px-2 py-2"
            onPress={() => answer([option.label])}
          >
            <View className="size-6 items-center justify-center rounded-md bg-control">
              <Typography type="body-xs" className="text-text-secondary">
                {String.fromCharCode(65 + optionIndex)}
              </Typography>
            </View>
            <View className="min-w-0 flex-1">
              <Typography type="body-sm" weight="medium">
                {option.label}
              </Typography>
              {option.description ? (
                <Typography type="body-xs" className="text-text-secondary">
                  {option.description}
                </Typography>
              ) : null}
            </View>
          </Button>
        ))}
      </View>
      <View className="flex-row items-center justify-between gap-2">
        <Typography type="body-xs" className="flex-1 text-text-secondary">
          Or type your answer
        </Typography>
        <Button variant="ghost" size="sm" isDisabled={disabled} onPress={() => answer([])}>
          <Button.Label>Skip</Button.Label>
        </Button>
      </View>
      {pending ? (
        <Typography type="body-xs" accessibilityLiveRegion="polite">
          Sending answers…
        </Typography>
      ) : null}
      {!canSend ? (
        <Typography type="body-xs" className="text-text-secondary">
          Reconnect to answer this form.
        </Typography>
      ) : null}
      {failedAnswers ? (
        <View className="flex-row items-center gap-2">
          <Typography type="body-xs" className="flex-1" accessibilityRole="alert">
            Couldn’t send your answers. Please try again.
          </Typography>
          <Button variant="ghost" size="sm" isDisabled={disabled} onPress={() => void submit(failedAnswers)}>
            <Button.Label>Retry</Button.Label>
          </Button>
        </View>
      ) : null}
    </View>
  );
}
