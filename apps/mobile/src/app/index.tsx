import { Button } from "heroui-native/button";
import { Text, View } from "react-native";

export default function Index() {
  return (
    <View className="flex-1 items-center justify-center gap-4 bg-background px-6">
      <Text className="text-center text-2xl font-semibold text-foreground">OpenBot Mobile</Text>
      <Button onPress={() => undefined}>Rozpocznij</Button>
    </View>
  );
}
