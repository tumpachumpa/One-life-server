DO $$
DECLARE
  r       RECORD;
  new_fx  jsonb := '[
    {"type":"block_chance","value":12,"_base":true},
    {"type":"block_power","value":40,"_base":true},
    {"name":"First Wall","type":"first_incoming_guaranteed_block","counterDamageMult":1,"description":"The first incoming hit each combat is completely blocked at no Block Power cost. The blow is immediately answered with a full-damage counter.","_base":true},
    {"type":"block_power_regen","value":5},
    {"type":"max_hp","value":18},
    {"type":"armor","value":6},
    {"type":"counter_chance","value":4},
    {"type":"crit_resist","value":5}
  ]'::jsonb;
  equip   jsonb;
  inv     jsonb;
  stash   jsonb;
  i       int;
  changed boolean;
BEGIN
  FOR r IN SELECT user_id, slot_id, save_data FROM heroes WHERE save_data IS NOT NULL LOOP
    equip   := r.save_data->'hero'->'equip';
    inv     := r.save_data->'hero'->'inventory';
    stash   := r.save_data->'stash';
    changed := false;

    -- Stonewall is always offhand
    IF equip->'offhand'->>'id' = 'stonewall'
    OR equip->'offhand'->>'baseId' = 'stonewall' THEN
      equip   := jsonb_set(equip, '{offhand,effects}', new_fx);
      changed := true;
      RAISE NOTICE 'equip:offhand user=% slot=%', r.user_id, r.slot_id;
    END IF;

    -- Inventory
    IF inv IS NOT NULL AND jsonb_array_length(inv) > 0 THEN
      FOR i IN 0 .. jsonb_array_length(inv) - 1 LOOP
        IF inv->i->'itemId'->>'id' = 'stonewall'
        OR inv->i->'itemId'->>'baseId' = 'stonewall' THEN
          inv     := jsonb_set(inv, ARRAY[i::text, 'itemId', 'effects'], new_fx);
          changed := true;
          RAISE NOTICE 'inventory[%] user=% slot=%', i, r.user_id, r.slot_id;
        END IF;
      END LOOP;
    END IF;

    -- Stash
    IF stash IS NOT NULL AND jsonb_array_length(stash) > 0 THEN
      FOR i IN 0 .. jsonb_array_length(stash) - 1 LOOP
        IF stash->i->'itemId'->>'id' = 'stonewall'
        OR stash->i->'itemId'->>'baseId' = 'stonewall' THEN
          stash   := jsonb_set(stash, ARRAY[i::text, 'itemId', 'effects'], new_fx);
          changed := true;
          RAISE NOTICE 'stash[%] user=% slot=%', i, r.user_id, r.slot_id;
        END IF;
      END LOOP;
    END IF;

    IF changed THEN
      UPDATE heroes
      SET save_data  = r.save_data
                       || jsonb_build_object('stash', stash)
                       || jsonb_build_object('hero',
                            (r.save_data->'hero')
                            || jsonb_build_object('equip', equip)
                            || jsonb_build_object('inventory', inv)),
          updated_at = NOW()
      WHERE user_id = r.user_id
        AND slot_id = r.slot_id;
    END IF;
  END LOOP;

  RAISE NOTICE 'Done.';
END $$;
