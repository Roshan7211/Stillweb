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
export default function ContextMenuSheet({ target, theme, onClose, onAction }: Props) {
  const run = (action: ContextAction) => {
    if (target) onAction(action, target);
    onClose();
  };
  const link = target?.link ?? '';
  const image = target?.image ?? '';

  return (
    <Sheet visible={!!target} onClose={onClose} theme={theme}>
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
