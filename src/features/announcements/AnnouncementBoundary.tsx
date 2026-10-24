import React, { Component, type ReactNode } from "react";
interface Props { children: ReactNode; onError: (error: unknown) => void; onClose: () => void }
/** A broken local renderer/chunk is a feature error; it must not take down the judge UI. */
export class AnnouncementBoundary extends Component<Props, { failed: boolean }> {
  declare props: Props;
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError("article"); this.props.onClose(); }
  render() { return this.state.failed ? null : this.props.children; }
}
