import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useTheme } from './theme';

// Only one row stays open at a time across every list.
let closePrevRow: (() => void) | null = null;

interface Props {
  /** swipe right (reveals the green side) — e.g. mark done */
  onSwipeRight?: () => void;
  /** swipe left (reveals the red side) — e.g. delete */
  onSwipeLeft?: () => void;
  rightIcon?: string;
  leftIcon?: string;
  children: React.ReactNode;
}

function SideAction({
  icon,
  bg,
  align,
  onTap,
}: {
  icon: string;
  bg: string;
  align: 'flex-start' | 'flex-end';
  onTap: () => void;
}) {
  return (
    <View style={[styles.action, { backgroundColor: bg, alignItems: align }]}>
      <Pressable onPress={onTap} hitSlop={10}>
        <Text style={styles.icon}>{icon}</Text>
      </Pressable>
    </View>
  );
}

/**
 * ONE swipeable row wrapper for every tab list.
 * Right swipe → green action, left swipe → red action.
 * Fires the action and snaps closed (remount via key); opening one row
 * closes whatever row was open before it.
 */
export function SwipeRow({
  onSwipeRight,
  onSwipeLeft,
  rightIcon = '✅',
  leftIcon = '🗑️',
  children,
}: Props) {
  const { palette: P } = useTheme();
  // bump the key to remount the Swipeable closed after an action fires
  const [nonce, setNonce] = useState(0);
  const closeSelf = () => setNonce((n) => n + 1);

  const fire = (dir: 'left' | 'right') => {
    if (closePrevRow) {
      const c = closePrevRow;
      closePrevRow = null;
      c();
    }
    closeSelf();
    (dir === 'left' ? onSwipeRight : onSwipeLeft)?.();
  };

  return (
    <Swipeable
      key={nonce}
      onSwipeableWillOpen={() => {
        // a new swipe starts: close whatever row was open, then register this one
        if (closePrevRow) {
          const c = closePrevRow;
          closePrevRow = null;
          c();
        }
        closePrevRow = closeSelf;
      }}
      onSwipeableOpen={fire}
      renderLeftActions={
        onSwipeRight
          ? () => (
              <SideAction
                icon={rightIcon}
                bg={P.success}
                align="flex-start"
                onTap={() => fire('left')}
              />
            )
          : undefined
      }
      renderRightActions={
        onSwipeLeft
          ? () => (
              <SideAction icon={leftIcon} bg={P.danger} align="flex-end" onTap={() => fire('right')} />
            )
          : undefined
      }
      overshootLeft={false}
      overshootRight={false}
    >
      {children}
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  action: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  icon: {
    fontSize: 24,
    color: '#fff',
  },
});
