import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

/// Bottom-nav scaffold wrapping the five primary tabs (Dashboard,
/// Masters, Txns, Reports, Profile). Each tab keeps its own navigation stack
/// via `StatefulShellRoute.indexedStack`, so tapping a tab restores its
/// scroll position + drilled-into screen — the same UX the web BFF gives.
///
/// Pure layout: the [navigationShell] is provided by the router and owns
/// the per-branch state; we only render the chrome and forward tab taps.
class AppShell extends StatelessWidget {
  const AppShell({super.key, required this.navigationShell});

  /// Provided by `StatefulShellRoute.indexedStack` — gives us
  /// `currentIndex` + `goBranch(i)` to switch tabs without losing state.
  final StatefulNavigationShell navigationShell;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: navigationShell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: navigationShell.currentIndex,
        onDestinationSelected: (i) => navigationShell.goBranch(
          i,
          // Re-tapping the active tab pops it back to its branch root
          // (standard tab-bar behaviour). Cheap UX win.
          initialLocation: i == navigationShell.currentIndex,
        ),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.dashboard_outlined),
            selectedIcon: Icon(Icons.dashboard),
            label: 'Dashboard',
          ),
          NavigationDestination(
            icon: Icon(Icons.inventory_2_outlined),
            selectedIcon: Icon(Icons.inventory_2),
            label: 'Masters',
          ),
          NavigationDestination(
            icon: Icon(Icons.receipt_long_outlined),
            selectedIcon: Icon(Icons.receipt_long),
            label: 'Txns',
          ),
          NavigationDestination(
            icon: Icon(Icons.bar_chart_outlined),
            selectedIcon: Icon(Icons.bar_chart),
            label: 'Reports',
          ),
          NavigationDestination(
            icon: Icon(Icons.person_outline),
            selectedIcon: Icon(Icons.person),
            label: 'Profile',
          ),
        ],
      ),
    );
  }
}
