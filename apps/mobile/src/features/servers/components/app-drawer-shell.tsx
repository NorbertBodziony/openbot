import * as Haptics from "expo-haptics";
import { type Href, router, usePathname } from "expo-router";
import { useThemeColor } from "heroui-native/hooks";
import { createContext, type PropsWithChildren, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";
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

import { useMobileSession } from "@/features/auth/context/mobile-session-context";
import { ServerDrawerContent } from "@/features/servers/components/server-drawer-content";
import { useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { isIOS } from "@/shared/lib/platform";

interface AppDrawerContextValue {
  openDrawer: () => void;
  closeDrawer: () => void;
}

const AppDrawerContext = createContext<AppDrawerContextValue | null>(null);
const DRAWER_SURFACE_MIN_RADIUS = 34;
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
  const [muted] = useThemeColor(["muted"]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerProgress = useSharedValue(0);
  const drawerWidth = Math.min(360, Math.max(280, width - 52));
  const drawerSideInset = Math.max(insets.left, 18);
  const drawerHeaderHeight = Math.max(insets.top, 16) + 56;
  const drawerListTopInset = drawerHeaderHeight + 8;
  const surfaceCornerRadius = Math.max(DRAWER_SURFACE_MIN_RADIUS, insets.top, insets.right, insets.bottom, insets.left);

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
            <ServerDrawerContent
              activeServerId={activeServer.id}
              headerHeight={drawerHeaderHeight}
              listTopInset={drawerListTopInset}
              muted={muted}
              servers={servers}
              session={session}
              sideInset={drawerSideInset}
              topInset={insets.top}
              onNavigate={navigateAfterClosing}
              onSelectServer={(serverId) => {
                selectServer(serverId);
                closeDrawer();
              }}
            />
          </Animated.View>

          <GestureDetector gesture={openingGesture}>
            <Animated.View
              className="flex-1 overflow-hidden bg-background"
              style={[
                {
                  borderCurve: "continuous",
                  borderRadius: surfaceCornerRadius,
                  boxShadow: "-12px 0 32px rgba(0, 0, 0, 0.28)",
                },
                surfaceStyle,
              ]}
            >
              {children}
              <Animated.View
                className="absolute inset-0 bg-drawer-scrim"
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
