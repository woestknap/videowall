-- Screen positions are deliberately fractional: the editor must never snap to a grid.
alter table public.devices alter column layout_x type double precision using layout_x::double precision;
alter table public.devices alter column layout_y type double precision using layout_y::double precision;
alter table public.devices alter column layout_width type double precision using layout_width::double precision;
alter table public.devices alter column layout_height type double precision using layout_height::double precision;

-- Reset the legacy grid arrangement into the fixed 7680 × 4320 freeform workspace.
-- A display's most recently reported resolution supplies its real aspect ratio.
with positioned as (
  select id,
    row_number() over (partition by wall_id order by created_at) - 1 as position,
    coalesce(width, 1920) as display_width,
    coalesce(height, 1080) as display_height
  from public.devices
)
update public.devices d
set layout_x = positioned.position * positioned.display_width,
    layout_y = 0,
    layout_width = positioned.display_width,
    layout_height = positioned.display_height
from positioned
where d.id = positioned.id;
