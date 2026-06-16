import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';

/// Phase 1 placeholder for the Dashboard tab. The real KPI strip + sync
/// summary + charts land in Phase 4; for now we just claim the route so the
/// bottom-nav shell + router redirects are exercisable end-to-end.
class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(title: const Text('Dashboard')),
      body: Center(
        child: Text(
          'Dashboard — coming in Phase 4',
          style: Theme.of(context)
              .textTheme
              .bodyLarge
              ?.copyWith(color: AppColors.text2),
        ),
      ),
    );
  }
}
