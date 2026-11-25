import 'package:flutter/material.dart';

import 'care_item_bulk_action_bar.dart';
import 'care_item_bulk_selection_scope.dart';

/// Viewport-pinned bulk bar while subset selection is active (#1673).
class CareItemBulkSelectionStickyBar extends StatelessWidget {
  const CareItemBulkSelectionStickyBar({super.key, required this.selection});

  final CareItemBulkSelection selection;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: selection,
      builder: (context, _) {
        if (!selection.showStickyBar) {
          return const SizedBox.shrink();
        }

        final theme = Theme.of(context);
        return Material(
          key: const Key('care_item_bulk_selection_sticky_bar'),
          elevation: 8,
          color: theme.colorScheme.surface,
          child: SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
              child: CareItemBulkActionBar(
                count: selection.selectedCount,
                muted: selection.stickyMuted,
                onMarkAllDone: selection.markSelected,
                onSkipAll: selection.skipSelected,
              ),
            ),
          ),
        );
      },
    );
  }
}
