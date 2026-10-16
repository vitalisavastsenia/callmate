import { Component, type ReactNode } from 'react';

export default class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="auth-screen"><section className="panel space-y-5" role="alert">
      <h1>Zeus Llama could not display this page</h1>
      <p>Your saved call data has not been cleared. Reload to restore the original attempt. If a call was in progress, check its state before starting another.</p>
      <p>If this keeps happening, keep the browser data and check the backend or browser storage settings.</p>
      <button type="button" className="primary" onClick={() => window.location.reload()}>Reload and restore</button>
    </section></main>;
  }
}
