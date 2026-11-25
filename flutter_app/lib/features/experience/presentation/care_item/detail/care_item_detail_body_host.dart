import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:pet_profile_app/features/health_tracking/health_tracking.dart';
import 'package:pet_profile_app/features/pet_profile/pet_profile.dart';
import 'care_item_bulk_selection_scope.dart';
import 'care_item_bulk_selection_sticky_bar.dart';
import 'care_item_detail_body.dart';

/// Owns bulk-selection scope and pins the subset action bar above the safe area.
class CareItemDetailBodyHost extends ConsumerStatefulWidget {
  const CareItemDetailBodyHost({
    super.key,
    required this.petId,
    required this.entry,
    required this.pet,
    required this.historyAsync,
    required this.entryId,
    required this.isClosed,
    required this.isEstablished,
    required this.onSeeHistory,
    this.careClosedReason,
    this.onCloseCare,
  });

  final String petId;
  final HealthEntry entry;
  final Pet pet;
  final AsyncValue<List<HealthHistoryEntry>> historyAsync;
  final String entryId;
  final bool isClosed;
  final bool isEstablished;
  final VoidCallback onSeeHistory;
  final String? careClosedReason;
  final VoidCallback? onCloseCare;

  @override
  ConsumerState<CareItemDetailBodyHost> createState() =>
      _CareItemDetailBodyHostState();
}

class _CareItemDetailBodyHostState extends ConsumerState<CareItemDetailBodyHost> {
  late final CareItemBulkSelection _bulkSelection;

  @override
  void initState() {
    super.initState();
    _bulkSelection = CareItemBulkSelection();
  }

  @override
  void dispose() {
    _bulkSelection.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(CareItemDetailBodyHost oldWidget) {
    super.didUpdateWidget(oldWidget);
    final needsAttentionBefore = _showsNeedsAttention(oldWidget);
    final needsAttentionNow = _showsNeedsAttention(widget);
    if (oldWidget.entryId != widget.entryId ||
        needsAttentionBefore != needsAttentionNow) {
      _bulkSelection.reset();
    }
  }

  bool _showsNeedsAttention(CareItemDetailBodyHost host) {
    return !host.isClosed &&
        !host.entry.isCompleted &&
        host.entry.schedule != null &&
        !host.entry.isPaused;
  }

  @override
  Widget build(BuildContext context) {
    return CareItemBulkSelectionScope(
      selection: _bulkSelection,
      child: ListenableBuilder(
        listenable: _bulkSelection,
        builder: (context, _) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: CareItemDetailBody(
                  petId: widget.petId,
                  entry: widget.entry,
                  pet: widget.pet,
                  historyAsync: widget.historyAsync,
                  entryId: widget.entryId,
                  isClosed: widget.isClosed,
                  isEstablished: widget.isEstablished,
                  onSeeHistory: widget.onSeeHistory,
                  careClosedReason: widget.careClosedReason,
                  onCloseCare: widget.onCloseCare,
                  reserveBottomInset: _bulkSelection.showStickyBar,
                ),
              ),
              CareItemBulkSelectionStickyBar(selection: _bulkSelection),
            ],
          );
        },
      ),
    );
  }
}