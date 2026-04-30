import { Easing } from 'react-native-reanimated';

import { motion } from '@/theme/tokens';

/** Andreas brand easing — `cubic-bezier(.65, 0, .35, 1)` from tokens.css. */
export const brandEase = Easing.bezier(...motion.ease);
