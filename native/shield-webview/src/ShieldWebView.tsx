import { requireNativeView } from 'expo';
import * as React from 'react';

import type { ShieldWebViewProps, ShieldWebViewRef } from './ShieldWebView.types';

const NativeView: React.ComponentType<ShieldWebViewProps & { ref?: React.Ref<ShieldWebViewRef> }> =
  requireNativeView('ShieldWebView');

/** Ad-blocking WebView. Navigation is driven through the ref (`loadUrl`, `goBack`, ...). */
export default function ShieldWebView(props: ShieldWebViewProps & { ref?: React.Ref<ShieldWebViewRef> }) {
  return <NativeView {...props} />;
}
