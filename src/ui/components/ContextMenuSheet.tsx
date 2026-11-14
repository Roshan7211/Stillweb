import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { displayUrl } from '../../browser/url';
import type { Theme } from '../theme';
import { Row, Sheet } from './primitives';

export type ContextTarget = { link: string; image: string; incognito: boolean };

export type ContextAction = 'open' | 'openPrivate' | 'copy' | 'share' | 'openImage' | 'downloadImage';

type Props = {
  target: ContextTarget | null;
  theme: Theme;
  onClose: () => void;
  onAction: (action: ContextAction, target: ContextTarget) => void;
};

/** Long-press menu for links and images. */
export default function ContextMenuSheet({ target: current, theme, onClose, onAction }: Props) {
  // The last link stays in the sheet while it slides away (the menu is closed by clearing it).
  const [target, setTarget] = useState(current);
  if (current && current !== target) setTarget(current);
  const run = (action: ContextAction) => {
    if (target) onAction(action, target);
    onClose();
  };
  const link = target?.link ?? '';
  const image = target?.image ?? '';

  return (
    <Sheet visible={!!current} onClose={onClose} theme={theme}>
      <Text style={[styles.title, { color: theme.muted }]} numberOfLines={2}>
        {displayUrl(link || image)}
      </Text>
      {link ? (
        <>
          {!target?.incognito ? <Row title="Open in new tab" icon="plus-square" theme={theme} onPress={() => run('open')} /> : null}
          <Row
            title={target?.incognito ? 'Open in new private tab' : 'Open in private tab'}
            icon="eye-off"
            theme={theme}
            onPress={() => run('openPrivate')}
          />
          <Row title="Copy link" icon="copy" theme={theme} onPress={() => run('copy')} />
          <Row title="Share link" icon="share-2" theme={theme} onPress={() => run('share')} />
        </>
      ) : null}
      {image ? (
        <>
          <Row title="Open image in new tab" icon="image" theme={theme} onPress={() => run('openImage')} />
          <Row title="Download image" icon="download" theme={theme} onPress={() => run('downloadImage')} />
        </>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 13, paddingHorizontal: 18, paddingBottom: 8 },
});
