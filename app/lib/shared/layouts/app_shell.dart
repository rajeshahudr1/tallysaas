import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/auth/session.dart';
import '../../core/gps/gps_tracker.dart';
import '../../core/update/app_update.dart';
import '../../features/menu/create_voucher_sheet.dart';

/// Bottom-nav scaffold wrapping the four primary tabs (Dashboard, Sales,
/// Purchase, More) with the Create (+) action docked in the middle. Each tab
/// keeps its own navigation stack via `StatefulShellRoute.indexedStack`.
///
/// The app now carries every web module, so the tabs are BROWSING entry points
/// rather than one-tab-per-module: Sales and Purchase render their menu group,
/// More renders the rest, and the centre + opens the voucher-create sheet.
/// RBAC lives inside those screens (they filter by the same module slugs the
/// web sidebar uses), so the bar itself is fixed and never re-indexes.
class AppShell extends ConsumerWidget {
  const AppShell({super.key, required this.navigationShell});

  /// Provided by `StatefulShellRoute.indexedStack` — gives us
  /// `currentIndex` + `goBranch(i)` to switch tabs without losing state.
  final StatefulNavigationShell navigationShell;

  // Fires the cloud app-update check ONCE per app run (not on every rebuild).
  static bool _updateChecked = false;
  // Starts GPS tracking ONCE for a linked salesman (the config gates the rest).
  static bool _gpsStarted = false;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final user = session is SessionSignedIn ? session.user : null;

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

    return Scaffold(
      body: navigationShell,
      // The Create action carries the brand gradient — it is THE primary action
      // in the product, so it gets the same treatment as the web's gradient
      // buttons rather than a flat fill.
      floatingActionButton: DecoratedBox(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          // brandButton, not brand: the FAB icon is white and the logo
        // green cannot carry white text (2.61:1).
        gradient: AppGradients.brandButton,
        ),
        child: FloatingActionButton(
          heroTag: 'app-shell-create',
          onPressed: () => showCreateVoucherSheet(context, ref),
          tooltip: 'Create',
          backgroundColor: Colors.transparent,
          foregroundColor: Colors.white,
          elevation: 0,
          highlightElevation: 0,
          child: const Icon(Icons.add),
        ),
      ),
      floatingActionButtonLocation: FloatingActionButtonLocation.centerDocked,
      bottomNavigationBar: BottomAppBar(
        color: AppColors.navSurface,
        shape: const CircularNotchedRectangle(),
        notchMargin: 6,
        padding: EdgeInsets.zero,
        child: Row(
          children: [
            _tab(0, Icons.dashboard_outlined, Icons.dashboard, 'Dashboard'),
            _tab(1, Icons.trending_up_outlined, Icons.trending_up, 'Sales'),
            const SizedBox(width: 56), // the notch under the Create button
            _tab(2, Icons.shopping_bag_outlined, Icons.shopping_bag, 'Purchase'),
            _tab(3, Icons.menu, Icons.menu_open, 'More'),
          ],
        ),
      ),
    );
  }

  /// One bottom-bar destination. All four tabs are always visible: Dashboard
  /// and More are universal, and Sales / Purchase render their own "no modules
  /// for your role" state when the role has nothing in that group.
  Widget _tab(int branch, IconData icon, IconData active, String label) {
    final selected = navigationShell.currentIndex == branch;
    final color = selected ? AppColors.primary : AppColors.text2;
    return Expanded(
      child: InkWell(
        // The selected tab is shown by COLOUR. Material's focus/hover fills on
        // top of that read as a stray grey rectangle — visible on web and
        // desktop, where a pointer parks over the last tab tapped.
        focusColor: Colors.transparent,
        highlightColor: Colors.transparent,
        hoverColor: Colors.transparent,
        onTap: () => navigationShell.goBranch(branch, initialLocation: selected),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(selected ? active : icon, size: 22, color: color),
              const SizedBox(height: 2),
              Text(
                label,
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                  color: color,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
