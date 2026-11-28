@care
Feature: Care calendar v1
  Read-only month calendar beside the care agenda.

  @P2
  Scenario: Dashboard calendar tab
    Given I am signed in to Pet Care with scheduled care
    When I open the care calendar from the dashboard
    Then I see the care calendar month grid

  @P2
  Scenario: Open Care date from calendar
    Given I am signed in with a materialised open occurrence this month
    When I tap the calendar day for that occurrence
    Then I see the Care date screen

  @P2
  Scenario: Planned absence overlay on calendar grid
    Given I am signed in with an active away plan this month
    When I open the care calendar from the dashboard
    Then I see away plan window semantics on an in-window day