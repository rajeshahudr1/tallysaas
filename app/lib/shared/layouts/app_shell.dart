import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/session.dart';
import '../../core/gps/gps_tracker.dart';
import '../../core/update/app_update.dart';

/// Bottom-nav scaffold wrapping the five primary tabs (Dashboard, Masters,
/// Txns, Reports, Profile). Each tab keeps its own navigation stack via
/// `StatefulShellRoute.indexedStack`.
///
/// RBAC: the Masters / Txns / Reports tabs are shown ONLY when the signed-in
/// role can see at least one module in that group (same idea as the web sidebar
/// dropping empty groups). Dashboard + Profile are always shown. Because the
/// shell's branches are fixed (0–4), we keep a branch index on each VISIBLE tab
/// and map the NavigationBar's (filtered) index back to the real branch.
class AppShell extends ConsumerWidget {
  const AppShell({super.key, required this.navigationShell});

  /// Provided by `StatefulShellRoute.indexedStack` — gives us
  /// `currentIndex` + `goBranch(i)` to switch tabs without losing state.
  final StatefulNavigationShell navigationShell;

  // Branch index → the permission modules that unlock that tab.
  static const _masters = [
    'companies', 'customers', 'suppliers', 'products',
    'categories', 'locations', 'sales-persons',
  ];
  static const _txns = [
    'sales-invoices', 'purchase-invoices', 'payments', 'receipts', 'journals',
  ];

  // Fires the cloud app-update check ONCE per app run (not on every rebuild).
  static bool _updateChecked = false;
  // Starts GPS tracking ONCE for a linked salesman (the config gates the rest).
  static bool _gpsStarted = false;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    bool show(bool gate) => user == null || gate;

    // One-shot cloud app-update prompt once the shell is up (post-login).
    if (!_updateChecked) {
      _updateChecked = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (context.mounted) maybePromptAppUpdate(context, ref);
      });
    }

    // Start GPS tracking once for a linked salesman. The super-admin config
    // (GET /field/gps-config) gates whether anything actually captures.
    if (!_gpsStarted && user != null && user.isSalesman) {
      _gpsStarted = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        ref.read(gpsTrackerProvider).start();
      });
    }

    // Each visible tab carries its REAL branch index (0–4).
    final tabs = <({int branch, NavigationDestination dest})>[
      (
        branch: 0,
        dest: const NavigationDestination(
          icon: Icon(Icons.dashboard_outlined),
          selectedIcon: Icon(Icons.dashboard),
          label: 'Dashboard',
        ),
      ),
      // Customer-portal login: the Masters tab carries their scoped Products /
      // Categories and the Txns tab their invoices — being the LINKED customer
      // is the entitlement (mirrors the web + API), so both tabs stay visible
      // even when the role has no master grants.
      if (show((user?.canAny(_masters) ?? false) || (user?.isCustomerUser ?? false)))
        (
          branch: 1,
          dest: const NavigationDestination(
            icon: Icon(Icons.inventory_2_outlined),
            selectedIcon: Icon(Icons.inventory_2),
            label: 'Masters',
          ),
        ),
      if (show((user?.canAny(_txns) ?? false) || (user?.isCustomerUser ?? false)))
        (
          branch: 2,
          dest: const NavigationDestination(
            icon: Icon(Icons.receipt_long_outlined),
            selectedIcon: Icon(Icons.receipt_long),
            label: 'Txns',
          ),
        ),
      if (show(user?.canModule('reports') ?? false))
        (
          branch: 3,
          dest: const NavigationDestination(
            icon: Icon(Icons.bar_chart_outlined),
            selectedIcon: Icon(Icons.bar_chart),
            label: 'Reports',
          ),
        ),
      (
        branch: 4,
        dest: const NavigationDestination(
          icon: Icon(Icons.person_outline),
          selectedIcon: Icon(Icons.person),
          label: 'Profile',
        ),
      ),
    ];

    // Map the active branch to its position among the VISIBLE tabs (fallback to
    // Dashboard if the active branch is hidden for this role).
    var selected = tabs.indexWhere((t) => t.branch == navigationShell.currentIndex);
    if (selected < 0) selected = 0;

    return Scaffold(
      body: navigationShell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: selected,
        onDestinationSelected: (i) {
          final branch = tabs[i].branch;
          navigationShell.goBranch(
            branch,
            initialLocation: branch == navigationShell.currentIndex,
          );
        },
        destinations: [for (final t in tabs) t.dest],
      ),
    );
  }
}
