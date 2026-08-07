import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/app_menu.dart';
import '../../app/theme.dart';
import '../../core/auth/session.dart';

/// The Create (+) sheet — a grid of every voucher type the role may create.
/// This is the mobile form of the web sidebar's "Create Vouchers" group.
/// Types whose form is not built yet show a "coming soon" note on tap.
Future<void> showCreateVoucherSheet(BuildContext context, WidgetRef ref) {
  final session = ref.read(sessionProvider);
  final user = session is SessionSignedIn ? session.user : null;
  final entries = visibleCreateEntries(user);

  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.card,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (ctx) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.add_circle_outline, size: 18, color: AppColors.primary),
                const SizedBox(width: 8),
                const Text(
                  'Create',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                ),
                const Spacer(),
                IconButton(
                  icon: const Icon(Icons.close),
                  onPressed: () => Navigator.pop(ctx),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.sm8),
            if (entries.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: AppSpacing.xl24),
                child: Text('Your role cannot create vouchers.'),
              )
            else
              Flexible(
                child: GridView.count(
                  shrinkWrap: true,
                  crossAxisCount: 3,
                  mainAxisSpacing: AppSpacing.md12,
                  crossAxisSpacing: AppSpacing.md12,
                  childAspectRatio: 0.95,
                  children: [
                    for (final e in entries) _CreateTile(entry: e),
                  ],
                ),
              ),
          ],
        ),
      ),
    ),
  );
}

class _CreateTile extends StatelessWidget {
  const _CreateTile({required this.entry});
  final MenuEntry entry;

  @override
  Widget build(BuildContext context) {
    final enabled = entry.route != null;
    return InkWell(
      borderRadius: BorderRadius.circular(AppRadius.md12),
      // A parked pointer must not leave one tile looking selected.
      hoverColor: Colors.transparent,
      onTap: () {
        Navigator.pop(context);
        if (enabled) {
          context.push(entry.route!);
        } else {
          ScaffoldMessenger.of(context)
            ..hideCurrentSnackBar()
            ..showSnackBar(SnackBar(content: Text('${entry.label} — coming soon.')));
        }
      },
      child: Container(
        padding: const EdgeInsets.all(AppSpacing.sm8),
        decoration: BoxDecoration(
          border: Border.all(color: AppColors.border),
          borderRadius: BorderRadius.circular(AppRadius.md12),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              entry.icon,
              size: 24,
              color: enabled ? AppColors.primary : AppColors.text3,
            ),
            const SizedBox(height: AppSpacing.sm8),
            Text(
              entry.label,
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: enabled ? AppColors.text1 : AppColors.text3,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
