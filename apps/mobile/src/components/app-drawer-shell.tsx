import * as Haptics from "expo-haptics";
import { type Href, router, usePathname } from "expo-router";
import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { Monitor, Plus, Server, Settings, Wifi, WifiOff } from "lucide-react-native";
import { createContext, type PropsWithChildren, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";

import { ProfileAvatar } from "@/components/profile-avatar";
import { SheetScrollEdgeEffect } from "@/components/sheet-scroll-edge-effect";
import { isIOS } from "@/lib/platform";
import { useMobileSession } from "@/providers/mobile-session-provider";
import { useMobileWorkspace } from "@/providers/mobile-workspace-provider";

interface AppDrawerContextValue {
  openDrawer: () => void;
  closeDrawer: () => void;
}

const AppDrawerContext = createContext<AppDrawerContextValue | null>(null);
const DRAWER_SURFACE_RADIUS = 34;
const DRAWER_SPRING = {
  dampingRatio: 0.8,
  duration: 300,
  overshootClamping: true,
  reduceMotion: ReduceMotion.System,
} as const;

function triggerDrawerHaptic(): void {
  if (isIOS) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

export function AppDrawerShell({ children }: PropsWithChildren) {
  const pathname = usePathname();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { session } = useMobileSession();
  const { activeServer, selectServer, servers } = useMobileWorkspace();
  const [foreground, muted] = useThemeColor(["foreground", "muted"]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerProgress = useSharedValue(0);
  const drawerWidth = Math.min(360, Math.max(280, width - 52));
  const drawerSideInset = Math.max(insets.left, 18);
  const drawerHeaderHeight = Math.max(insets.top, 16) + 56;
  const drawerListTopInset = drawerHeaderHeight + 8;

  const commitDrawerState = useCallback((open: boolean) => setDrawerOpen(open), []);

  const openDrawer = useCallback(() => {
    triggerDrawerHaptic();
    setDrawerOpen(true);
    drawerProgress.set(
      withSpring(1, DRAWER_SPRING, (finished) => {
        if (finished) scheduleOnRN(commitDrawerState, true);
      }),
    );
  }, [commitDrawerState, drawerProgress]);

  const closeDrawer = useCallback(() => {
    triggerDrawerHaptic();
    drawerProgress.set(
      withSpring(0, DRAWER_SPRING, (finished) => {
        if (finished) scheduleOnRN(commitDrawerState, false);
      }),
    );
  }, [commitDrawerState, drawerProgress]);

  useEffect(() => {
    if (session) return;
    setDrawerOpen(false);
    drawerProgress.set(0);
  }, [drawerProgress, session]);

  const openingGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!drawerOpen && pathname === "/connected")
        .activeOffsetX(12)
        .failOffsetX(-10)
        .failOffsetY([-10, 10])
        .onUpdate((event) => {
          drawerProgress.set(Math.min(1, Math.max(0, event.translationX / drawerWidth)));
        })
        .onEnd((event) => {
          const projected = drawerProgress.get() + event.velocityX / drawerWidth / 6;
          const shouldOpen = projected > 0.45;
          if (shouldOpen) scheduleOnRN(triggerDrawerHaptic);
          drawerProgress.set(
            withSpring(
              shouldOpen ? 1 : 0,
              { ...DRAWER_SPRING, velocity: event.velocityX / drawerWidth },
              (finished) => {
                if (finished) scheduleOnRN(commitDrawerState, shouldOpen);
              },
            ),
          );
        }),
    [commitDrawerState, drawerOpen, drawerProgress, drawerWidth, pathname],
  );

  const closingGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(drawerOpen)
        .activeOffsetX(-8)
        .failOffsetX(12)
        .failOffsetY([-12, 12])
        .onUpdate((event) => {
          drawerProgress.set(Math.min(1, Math.max(0, 1 + event.translationX / drawerWidth)));
        })
        .onEnd((event) => {
          const projected = drawerProgress.get() + event.velocityX / drawerWidth / 6;
          const shouldOpen = projected > 0.55;
          if (!shouldOpen) scheduleOnRN(triggerDrawerHaptic);
          drawerProgress.set(
            withSpring(
              shouldOpen ? 1 : 0,
              { ...DRAWER_SPRING, velocity: event.velocityX / drawerWidth },
              (finished) => {
                if (finished) scheduleOnRN(commitDrawerState, shouldOpen);
              },
            ),
          );
        }),
    [commitDrawerState, drawerOpen, drawerProgress, drawerWidth],
  );

  const surfaceStyle = useAnimatedStyle(() => ({
    borderRadius: interpolate(drawerProgress.get(), [0, 1], [0, DRAWER_SURFACE_RADIUS]),
    transform: [{ translateX: drawerProgress.get() * drawerWidth }],
  }));
  const drawerStyle = useAnimatedStyle(() => ({
    opacity: interpolate(drawerProgress.get(), [0, 1], [0.55, 1]),
    transform: [{ translateX: interpolate(drawerProgress.get(), [0, 1], [-24, 0]) }],
  }));
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(drawerProgress.get(), [0, 1], [0, 0.3]),
  }));

  const navigateAfterClosing = useCallback(
    (href: Href) => {
      closeDrawer();
      setTimeout(() => router.push(href), 300);
    },
    [closeDrawer],
  );

  const contextValue = useMemo(() => ({ closeDrawer, openDrawer }), [closeDrawer, openDrawer]);

  if (!session) {
    return <AppDrawerContext.Provider value={contextValue}>{children}</AppDrawerContext.Provider>;
  }

  const emailSeparatorIndex = session.user.email.indexOf("@");
  const displayName = emailSeparatorIndex > 0 ? session.user.email.slice(0, emailSeparatorIndex) : session.user.email;
  const iconColor = String(foreground);
  const mutedColor = String(muted);

  return (
    <AppDrawerContext.Provider value={contextValue}>
      <GestureDetector gesture={closingGesture}>
        <View className="flex-1 bg-sidebar">
          <Animated.View
            style={[
              {
                bottom: 0,
                left: 0,
                paddingBottom: Math.max(insets.bottom, 12),
                paddingLeft: drawerSideInset,
                position: "absolute",
                top: 0,
                width: drawerWidth,
              },
              drawerStyle,
            ]}
            accessibilityElementsHidden={!drawerOpen}
            importantForAccessibility={drawerOpen ? "auto" : "no-hide-descendants"}
          >
            <ScrollView
              className="flex-1"
              contentContainerClassName="gap-1 pr-3"
              contentContainerStyle={{ paddingTop: drawerListTopInset }}
              contentInsetAdjustmentBehavior="never"
              showsVerticalScrollIndicator={false}
            >
              {servers.map((serverItem) => {
                const selected = serverItem.id === activeServer.id;
                const ServerIcon = serverItem.kind === "local" ? Monitor : Server;
                const StateIcon = serverItem.state === "online" ? Wifi : WifiOff;

                return (
                  <Pressable
                    key={serverItem.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${serverItem.name}, ${serverItem.state}`}
                    className={`min-h-16 flex-row items-center gap-3 rounded-2xl px-3 py-2 ${selected ? "bg-control-active" : ""}`}
                    onPress={() => {
                      selectServer(serverItem.id);
                      closeDrawer();
                    }}
                  >
                    <View
                      className="size-11 items-center justify-center rounded-[15px]"
                      style={{ backgroundColor: serverItem.accent, borderCurve: "continuous" }}
                    >
                      <ServerIcon color="#100d12" size={21} strokeWidth={1.8} />
                    </View>
                    <View className="min-w-0 flex-1 gap-0.5">
                      <Typography.Paragraph weight="semibold" numberOfLines={1}>
                        {serverItem.name}
                      </Typography.Paragraph>
                      <View className="flex-row items-center gap-1.5">
                        <StateIcon color={mutedColor} size={12} strokeWidth={2} />
                        <Typography.Paragraph type="body-xs" className="capitalize text-text-secondary">
                          {serverItem.state}
                          {serverItem.kind === "remote" ? " · Remote" : " · Paired desktop"}
                        </Typography.Paragraph>
                      </View>
                    </View>
                  </Pressable>
                );
              })}

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Join a server"
                className="mt-2 min-h-14 flex-row items-center gap-3 rounded-2xl px-3 py-2"
                onPress={() => navigateAfterClosing("/add-server")}
              >
                <View className="size-11 items-center justify-center rounded-[15px] border border-border bg-control">
                  <Plus color={iconColor} size={21} strokeWidth={1.8} />
                </View>
                <Typography.Paragraph weight="semibold">Join a server</Typography.Paragraph>
              </Pressable>
            </ScrollView>

            <SheetScrollEdgeEffect
              style={{
                height: drawerHeaderHeight + 32,
                left: -drawerSideInset,
                position: "absolute",
                right: -DRAWER_SURFACE_RADIUS,
                top: 0,
                zIndex: 10,
              }}
            />

            <View
              className="absolute right-0 z-20 h-14 justify-center"
              pointerEvents="none"
              style={{ left: -drawerSideInset, paddingLeft: drawerSideInset + 8, top: Math.max(insets.top, 16) }}
            >
              <Typography.Heading type="h4" weight="bold">
                Servers
              </Typography.Heading>
            </View>

            <View className="mr-3 flex-row items-center gap-2 border-t border-border pt-3">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Account: ${displayName}`}
                className="min-h-15 min-w-0 flex-1 flex-row items-center gap-3 rounded-2xl px-2 py-1.5"
                onPress={() => navigateAfterClosing("/settings")}
              >
                <ProfileAvatar name={displayName} imageUrl={session.user.avatarUrl} size={44} />
                <View className="min-w-0 flex-1">
                  <Typography.Paragraph weight="semibold" numberOfLines={1}>
                    {displayName}
                  </Typography.Paragraph>
                  <Typography.Paragraph type="body-xs" className="text-text-secondary" numberOfLines={1} selectable>
                    {session.user.email}
                  </Typography.Paragraph>
                </View>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Settings"
                hitSlop={8}
                className="size-12 items-center justify-center rounded-2xl bg-control"
                onPress={() => navigateAfterClosing("/settings")}
              >
                <Settings color={iconColor} size={21} strokeWidth={1.8} />
              </Pressable>
            </View>
          </Animated.View>

          <GestureDetector gesture={openingGesture}>
            <Animated.View
              className="flex-1 overflow-hidden bg-background"
              style={[{ boxShadow: "-12px 0 32px rgba(0, 0, 0, 0.28)" }, surfaceStyle]}
            >
              {children}
              <Animated.View
                className="absolute inset-0 bg-black"
                pointerEvents={drawerOpen ? "auto" : "none"}
                style={scrimStyle}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close server drawer"
                  className="flex-1"
                  onPress={closeDrawer}
                />
              </Animated.View>
            </Animated.View>
          </GestureDetector>
        </View>
      </GestureDetector>
    </AppDrawerContext.Provider>
  );
}

export function useAppDrawer(): AppDrawerContextValue {
  const value = useContext(AppDrawerContext);
  if (!value) throw new Error("useAppDrawer must be used within AppDrawerShell.");
  return value;
}
