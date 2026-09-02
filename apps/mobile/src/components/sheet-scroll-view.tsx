import type { PropsWithChildren, ReactNode } from "react";
import { type ScrollViewProps, View } from "react-native";
import Animated, { useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";

import { SheetScrollEdgeEffect } from "@/components/sheet-scroll-edge-effect";

interface SheetScrollViewProps extends PropsWithChildren {
  className?: string;
  contentContainerClassName?: string;
  contentInsetAdjustmentBehavior?: ScrollViewProps["contentInsetAdjustmentBehavior"];
  header?: ReactNode;
  keyboardDismissMode?: ScrollViewProps["keyboardDismissMode"];
  keyboardShouldPersistTaps?: ScrollViewProps["keyboardShouldPersistTaps"];
  showsVerticalScrollIndicator?: boolean;
}

export function SheetScrollView({
  children,
  className = "bg-background",
  contentContainerClassName,
  contentInsetAdjustmentBehavior = "automatic",
  header,
  keyboardDismissMode,
  keyboardShouldPersistTaps,
  showsVerticalScrollIndicator = false,
}: SheetScrollViewProps) {
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      scrollY.value = event.contentOffset.y;
    },
  });

  return (
    <Animated.ScrollView
      className={className}
      contentInsetAdjustmentBehavior={contentInsetAdjustmentBehavior}
      keyboardDismissMode={keyboardDismissMode}
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      scrollEventThrottle={16}
      showsVerticalScrollIndicator={showsVerticalScrollIndicator}
      stickyHeaderIndices={[0]}
      onScroll={onScroll}
    >
      <View className="z-10" style={header ? undefined : { height: 1, marginBottom: -1 }}>
        <SheetScrollEdgeEffect
          scrollY={scrollY}
          style={
            header
              ? { bottom: -24, left: 0, position: "absolute", right: 0, top: 0 }
              : { height: 34, left: 0, position: "absolute", right: 0, top: 0 }
          }
        />
        {header}
      </View>
      <View className={contentContainerClassName}>{children}</View>
    </Animated.ScrollView>
  );
}
