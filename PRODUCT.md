# Smart Parking
<!-- impeccable:product-schema 1 -->

## Platform
web

## Users
University students exhibiting a four-space Arduino parking model and visitors watching occupancy change live.

## Product Purpose
Make physical button input immediately legible as parking availability. Demonstrate the complete serial-to-browser path without a database or external service.

## Operating Context
Omarchy Linux computer, USB Arduino Uno, D2–D5 pull-up buttons, 9600 baud. Local demonstration can operate without hardware.

## Capabilities and Constraints
Four spaces, isolated simulation, retained hardware snapshot, explicit disconnection, reconnect, bounded activity log, FC-51 inputs and manually controlled SG90 entry-gate target. Gate controls require synchronized hardware, opening requires availability, and closing remains manual. Firmware confirmation reports a software target; the SG90 has no physical position feedback. Never upload firmware or modify system permissions automatically.

## Brand Commitments
Smart Parking. Spanish controls confirmed by user. Dark navy/graphite, emerald availability, soft-red occupancy, modern Inter/Geist typography, overhead map as primary visual.

## Product Principles
- Never disguise unknown or stale hardware readings as live availability.
- Show physical cause and effect immediately.
- Keep setup appropriate for a university fair.
- Preserve independent demo and hardware state.
