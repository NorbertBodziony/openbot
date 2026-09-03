import { CameraView, useCameraPermissions } from "expo-camera";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Alert, Button, Card, Spinner, Surface } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { Camera, ScanLine } from "lucide-react-native";
import { useEffect, useState } from "react";
import { AppState, Linking, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";

import { redeemMobileConnectUrl } from "@/features/auth/api/mobile-auth";
import { useMobileSession } from "@/features/auth/context/mobile-session-context";
import { isAndroid, isIOS } from "@/shared/lib/platform";

type ScanState = { status: "idle" } | { status: "connecting" } | { status: "error"; message: string };

function ScannerStatus({ scanState, onRetry }: { scanState: ScanState; onRetry: () => void }) {
  const [foreground, accent] = useThemeColor(["foreground", "accent"]);

  if (scanState.status === "error") {
    return (
      <Card variant="default" className="gap-4 rounded-3xl p-4">
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Couldn’t connect</Alert.Title>
            <Alert.Description selectable>{scanState.message}</Alert.Description>
          </Alert.Content>
        </Alert>
        <Button size="md" variant="secondary" onPress={onRetry}>
          <Button.Label>Scan again</Button.Label>
        </Button>
      </Card>
    );
  }

  return (
    <Card variant="default" className="rounded-3xl p-4">
      <Card.Body className="flex-row items-center gap-3">
        {scanState.status === "connecting" ? (
          <Surface variant="tertiary" className="size-11 items-center justify-center rounded-2xl p-0">
            <Spinner size="sm" color={accent} />
          </Surface>
        ) : (
          <Surface variant="tertiary" className="size-11 items-center justify-center rounded-2xl p-0">
            <ScanLine size={22} color={foreground} strokeWidth={1.75} />
          </Surface>
        )}
        <View className="min-w-0 flex-1 gap-0.5">
          <Card.Title className="font-sans text-body font-semibold">
            {scanState.status === "connecting" ? "Connecting your phone…" : "Scan the desktop code"}
          </Card.Title>
          <Card.Description className="font-sans text-caption">
            {scanState.status === "connecting"
              ? "Verifying the one-time pairing request."
              : "Keep the QR code centered inside the frame."}
          </Card.Description>
        </View>
      </Card.Body>
    </Card>
  );
}

export function ScanQrCodeScreen() {
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [scanState, setScanState] = useState<ScanState>({ status: "idle" });
  const [foreground, accentForeground] = useThemeColor(["foreground", "accent-foreground"]);
  const { width: windowWidth } = useWindowDimensions();
  const scannerFrameSize = Math.min(windowWidth - 80, 280);
  const { connect: finishSignIn } = useMobileSession();

  useEffect(() => {
    if (permission?.granted || permission?.canAskAgain !== false) return;

    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener("change", (state) => {
      const returnedToForeground = state === "active" && previousState !== "active";
      previousState = state;
      if (returnedToForeground) void getPermission();
    });

    return () => subscription.remove();
  }, [getPermission, permission?.canAskAgain, permission?.granted]);

  async function connect(data: string): Promise<void> {
    if (scanState.status !== "idle") return;
    setScanState({ status: "connecting" });
    try {
      finishSignIn(await redeemMobileConnectUrl(data));
    } catch (error) {
      setScanState({
        status: "error",
        message: error instanceof Error ? error.message : "OpenBot could not connect this phone.",
      });
    }
  }

  if (!permission) {
    return (
      <>
        <Stack.Screen options={{ headerTintColor: foreground }} />
        <View className="flex-1 items-center justify-center bg-background">
          <Spinner color="default" accessibilityLabel="Loading camera" />
        </View>
      </>
    );
  }

  if (!permission.granted) {
    const canRequestPermission = permission.canAskAgain;

    return (
      <>
        <Stack.Screen options={{ headerTintColor: foreground }} />
        <ScrollView
          className="flex-1 bg-background"
          contentContainerClassName="min-h-full grow px-5 pb-safe-offset-8 pt-8"
          contentInsetAdjustmentBehavior="automatic"
        >
          <View className="mx-auto w-full max-w-md flex-1 justify-center">
            <Card variant="secondary" className="gap-6 rounded-3xl p-5">
              <Card.Header>
                <Surface variant="tertiary" className="size-14 items-center justify-center rounded-2xl p-0">
                  <Camera size={27} color={foreground} strokeWidth={1.75} />
                </Surface>
              </Card.Header>

              <Card.Body className="gap-2">
                <Card.Title accessibilityRole="header" className="font-sans text-title font-semibold">
                  Camera access required
                </Card.Title>
                <Card.Description className="font-sans text-body leading-6 text-text-secondary">
                  {canRequestPermission
                    ? "OpenBot uses the camera only to scan the one-time QR code shown in the desktop app."
                    : "Camera access is blocked. Enable it for OpenBot in device settings, then return here to pair your phone."}
                </Card.Description>
              </Card.Body>

              <Card.Footer>
                <Button
                  size="lg"
                  className="w-full"
                  onPress={canRequestPermission ? requestPermission : () => void Linking.openSettings()}
                >
                  <Camera size={19} color={accentForeground} strokeWidth={2} />
                  <Button.Label className="font-sans font-semibold">
                    {canRequestPermission ? "Allow camera access" : "Open settings"}
                  </Button.Label>
                </Button>
              </Card.Footer>
            </Card>
          </View>
        </ScrollView>
      </>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerTransparent: isIOS,
          headerStyle: isAndroid ? { backgroundColor: "#000000" } : undefined,
          headerTintColor: "#ffffff",
        }}
      />
      <StatusBar style="light" />
      <View className="flex-1 bg-black">
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={scanState.status === "idle" ? ({ data }) => void connect(data) : undefined}
        />

        <View pointerEvents="none" className="absolute inset-0 items-center justify-center px-10 pb-24">
          <View
            className="rounded-[28px] border-2 border-white"
            style={{ borderCurve: "continuous", height: scannerFrameSize, width: scannerFrameSize }}
          />
        </View>

        <View className="absolute inset-x-5 bottom-safe-offset-5">
          <ScannerStatus scanState={scanState} onRetry={() => setScanState({ status: "idle" })} />
        </View>
      </View>
    </>
  );
}
