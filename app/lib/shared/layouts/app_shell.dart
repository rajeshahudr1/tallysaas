import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/session.dart';

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

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;
    bool show(bool gate) => user == null || gate;

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
      if (show(user?.canAny(_masters) ?? false))
        (
          branch: 1,
          dest: const NavigationDestination(
            icon: Icon(Icons.inventory_2_outlined),
            selectedIcon: Icon(Icons.inventory_2),
            label: 'Masters',
          ),
        ),
      if (show(user?.canAny(_txns) ?? false))
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
