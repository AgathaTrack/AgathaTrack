import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

/// Selection state for partial bulk Mark/Skip on Care Item started rows (#1673).
class CareItemBulkSelection extends ChangeNotifier {
  bool _selectionMode = false;
  final Set<String> _selectedIds = {};

  bool _stickyMuted = false;
  Future<void> Function()? _onMarkSelected;
  Future<void> Function()? _onSkipSelected;

  bool get selectionMode => _selectionMode;
  Set<String> get selectedIds => Set.unmodifiable(_selectedIds);
  int get selectedCount => _selectedIds.length;
  bool get showStickyBar => _selectionMode && _selectedIds.length >= 2;

  bool get stickyMuted => _stickyMuted;

  void toggleSelectionMode() {
    _selectionMode = !_selectionMode;
    if (!_selectionMode) {
      _selectedIds.clear();
    }
    notifyListeners();
  }

  void setSelected(String occurrenceId, bool selected) {
    if (selected) {
      _selectedIds.add(occurrenceId);
    } else {
      _selectedIds.remove(occurrenceId);
    }
    notifyListeners();
  }

  void clearAfterBulk() {
    _selectionMode = false;
    _selectedIds.clear();
    notifyListeners();
  }

  /// Drop selections that no longer appear in the started list (after row Mark/Skip).
  void reconcileOpenIds(Set<String> openIds) {
    final before = _selectedIds.length;
    _selectedIds.removeWhere((id) => !openIds.contains(id));
    if (_selectedIds.length != before) {
      SchedulerBinding.instance.addPostFrameCallback((_) => notifyListeners());
    }
  }

  /// Clears mode and selection when the care item leaves the needs-attention surface.
  void reset() {
    if (!_selectionMode && _selectedIds.isEmpty) return;
    _selectionMode = false;
    _selectedIds.clear();
    notifyListeners();
  }

  /// Refreshes sticky callbacks each build; does not notify (safe during build).
  void bindStickyActions({
    required bool muted,
    required Future<void> Function() onMarkSelected,
    required Future<void> Function() onSkipSelected,
  }) {
    _stickyMuted = muted;
    _onMarkSelected = onMarkSelected;
    _onSkipSelected = onSkipSelected;
  }

  Future<void> markSelected() async => _onMarkSelected?.call();
  Future<void> skipSelected() async => _onSkipSelected?.call();
}

class CareItemBulkSelectionScope
    extends InheritedNotifier<CareItemBulkSelection> {
  const CareItemBulkSelectionScope({
    super.key,
    required CareItemBulkSelection selection,
    required super.child,
  }) : super(notifier: selection);

  static CareItemBulkSelection? maybeOf(BuildContext context) {
    return context
        .dependOnInheritedWidgetOfExactType<CareItemBulkSelectionScope>()
        ?.notifier;
  }
}
