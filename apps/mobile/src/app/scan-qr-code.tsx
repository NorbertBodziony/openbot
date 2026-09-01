import { CameraView, useCameraPermissions } from "expo-camera";
import { Link } from "expo-router";
import { Button } from "heroui-native/button";
import { useThemeColor } from "heroui-native/hooks";
import { ChevronLeft, QrCode } from "lucide-react-native";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";

import { redeemMobileConnectUrl } from "@/lib/mobile-auth";
import { useMobileSession } from "@/providers/mobile-session-provider";

type ScanState = { status: "idle" } | { status: "connecting" } | { status: "error"; message: string };

function ScreenBackButton({ iconColor }: { iconColor: string }) {
  return (
    <Link href="/" dismissTo asChild>
      <Button
        size="sm"
        variant="secondary"
        isIconOnly
        accessibilityLabel="Back"
        className="rounded-full border border-border"
      >
        <ChevronLeft size={20} color={iconColor} strokeWidth={2} />
      </Button>
    </Link>
  );
}

export default function ScanQrCode() {
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [scanState, setScanState] = useState<ScanState>({ status: "idle" });
  const foreground = useThemeColor("foreground");
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
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator color={foreground} accessibilityLabel="Loading camera" />
      </View>
    );
  }

  if (!permission.granted) {
    const canRequestPermission = permission.canAskAgain;

    return (
      <ScrollView
        className="flex-1 bg-background"
        contentContainerClassName="min-h-full flex-grow px-6 pt-safe-offset-3 pb-safe-offset-8"
        contentInsetAdjustmentBehavior="automatic"
      >
        <ScreenBackButton iconColor={foreground} />

        <View className="flex-1 items-center justify-center gap-6 pb-14">
          <View className="size-20 items-center justify-center rounded-4xl border border-border bg-control">
            <QrCode size={36} color={foreground} strokeWidth={1.5} />
          </View>
          <View className="max-w-sm items-center gap-2">
            <Text
              accessibilityRole="header"
              className="text-center font-sans text-heading font-semibold text-foreground"
            >
              Camera access required
            </Text>
            <Text className="text-center font-sans text-body text-text-secondary">
              {canRequestPermission
                ? "OpenBot uses the camera only to scan the QR code shown in the desktop app."
                : "Camera access is blocked. Enable it for OpenBot in your device settings, then return to scan the QR code."}
            </Text>
          </View>
          <Button
            size="md"
            className="w-full max-w-sm"
            onPress={canRequestPermission ? requestPermission : () => void Linking.openSettings()}
          >
            <Button.Label className="font-sans">
              {canRequestPermission ? "Allow camera access" : "Open settings"}
            </Button.Label>
          </Button>
        </View>
      </ScrollView>
    );
  }

  return (
    <View className="flex-1 bg-black">
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={scanState.status === "idle" ? ({ data }) => void connect(data) : undefined}
      />

      <View className="absolute inset-x-0 top-0 flex-row items-center justify-between px-5 pt-safe-offset-3">
        <ScreenBackButton iconColor={foreground} />
        <Text className="font-sans text-body font-semibold text-white">Scan QR code</Text>
        <View className="size-10" />
      </View>

      <View pointerEvents="none" className="absolute inset-0 items-center justify-center px-10">
        <View
          className="rounded-[28px] border-2 border-white"
          style={{ borderCurve: "continuous", height: scannerFrameSize, width: scannerFrameSize }}
        />
        <Text className="mt-6 text-center font-sans text-body text-white">
          Position the desktop QR code inside the frame.
        </Text>
      </View>

      {scanState.status !== "idle" ? (
        <View className="absolute inset-x-5 bottom-safe-offset-5 gap-4 rounded-3xl border border-border bg-background p-5">
          <View className="gap-1">
            <Text className="font-sans text-body font-semibold text-foreground">
              {scanState.status === "connecting" ? "Connecting your phone…" : "Couldn’t connect"}
            </Text>
            {scanState.status === "connecting" ? (
              <ActivityIndicator color={foreground} accessibilityLabel="Signing in" className="mt-3 self-start" />
            ) : (
              <Text className="font-sans text-caption text-muted">{scanState.message}</Text>
            )}
          </View>
          {scanState.status === "error" ? (
            <Button size="md" variant="secondary" onPress={() => setScanState({ status: "idle" })}>
              <Button.Label className="font-sans">Scan again</Button.Label>
            </Button>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
