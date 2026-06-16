import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models/user.dart';

/// Three possible session states. The router reads this to decide between
/// SplashScreen (`loading`), Login (`anonymous`), and the AppShell
/// (`signedIn`).
sealed class SessionState {
  const SessionState();
}

class SessionLoading extends SessionState {
  const SessionLoading();
}

class SessionAnonymous extends SessionState {
  const SessionAnonymous();
}

class SessionSignedIn extends SessionState {
  const SessionSignedIn(this.user);
  final AppUser user;
}

/// Holder for the current session state. Methods are intentionally
/// imperative (`setSignedIn`, `setAnonymous`) — AuthService owns the
/// transitions and exposes a higher-level API on top. Anything that just
/// needs to *read* the current user calls `ref.watch(sessionProvider)`.
class SessionController extends StateNotifier<SessionState> {
  SessionController() : super(const SessionLoading());

  void setLoading()             => state = const SessionLoading();
  void setAnonymous()           => state = const SessionAnonymous();
  void setSignedIn(AppUser u)   => state = SessionSignedIn(u);
}

final sessionProvider =
    StateNotifierProvider<SessionController, SessionState>((ref) {
  return SessionController();
});
