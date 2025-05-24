----------------------------------------------------------
-- Adapted by Christian Mäder
-- Based on instant-replay.lua from obs_project.
-- Licensed under GPL 2.0
----------------------------------------------------------

local obs                  = obslua

local attempts             = 0
local max_attempts         = 20
local load_delay           = 100
local log_level            = obs.LOG_INFO

local source_name          = ""
local previous_replay_path = ""

----------------------------------------------------------

local function logger(level, string)
  if level > log_level then
    return
  end

  obs.script_log(level, string)
end

local function try_update_replay_path()
  local last_replay_path = obs.obs_frontend_get_last_replay()

  logger(obs.LOG_DEBUG, "Trying to update new replay path to '" .. last_replay_path .. "'.")

  local new_path = last_replay_path ~= nil and last_replay_path ~= previous_replay_path

  if new_path then
    previous_replay_path = last_replay_path
  end

  if not new_path then
    attempts = attempts + 1

    if attempts >= 10 then
      obs.remove_current_callback()
    end
    return
  end

  local source = obs.obs_get_source_by_name(source_name)
  if source == nil then
    obs.remove_current_callback()
    obs.obs_source_release(source)
    logger(obs.LOG_WARNING, "No source with name '" .. source_name .. "'!")
  end

  local settings = obs.obs_data_create()
  local source_id = obs.obs_source_get_id(source)
  if source_id == "ffmpeg_source" then
    obs.obs_data_set_string(settings, "local_file", previous_replay_path)
    obs.obs_data_set_bool(settings, "is_local_file", true)
    obs.obs_data_set_bool(settings, "close_when_inactive", true)
    obs.obs_data_set_bool(settings, "restart_on_activate", true)

    -- updating will automatically cause the source to
    -- refresh if the source is currently active
    obs.obs_source_update(source, settings)
  elseif source_id == "vlc_source" then
    -- "playlist"
    local array = obs.obs_data_array_create()
    local item = obs.obs_data_create()
    obs.obs_data_set_string(item, "value", previous_replay_path)
    obs.obs_data_array_push_back(array, item)
    obs.obs_data_set_array(settings, "playlist", array)

    -- updating will automatically cause the source to
    -- refresh if the source is currently active
    obs.obs_source_update(source, settings)
    obs.obs_data_release(item)
    obs.obs_data_array_release(array)
  end

  logger(obs.LOG_INFO, "Updated media source '" .. source_name .. "' to replay path '" .. last_replay_path .. "'.")

  obs.obs_data_release(settings)
  obs.obs_source_release(source)
  obs.remove_current_callback()
end

local function frontend_event_cb(event)
  if event ~= obs.OBS_FRONTEND_EVENT_REPLAY_BUFFER_SAVED then
    return
  end

  logger(obs.LOG_DEBUG, "Replay buffer saved callback function invoked.")

  local replay_buffer = obs.obs_frontend_get_replay_buffer_output()
  if replay_buffer == nil then
    logger(obs.LOG_WARNING, "No active replay buffer!")
    obs.obs_output_release(replay_buffer)
    return
  end

  if obs.obs_output_active(replay_buffer) then
    attempts = 0
    obs.timer_add(try_update_replay_path, 500)
  else
    logger(obs.LOG_WARNING, "The replay buffer output is not active.")
  end

  obs.obs_output_release(replay_buffer)
end

----------------------------------------------------------

-- A function named script_update will be called when settings are changed
function script_update(settings)
  source_name = obs.obs_data_get_string(settings, "source")
  max_attempts = obs.obs_data_get_int(settings, "max_attempts")
  load_delay = obs.obs_data_get_int(settings, "load_delay")
  log_level = obs.obs_data_get_int(settings, "log_level")
end

function script_defaults(settings)
  obs.obs_data_set_int(settings, "max_attempts", max_attempts)
  obs.obs_data_set_int(settings, "load_delay", load_delay)
  obs.obs_data_set_int(settings, "log_level", log_level)
end

-- A function named script_description returns the description shown to
-- the user
function script_description()
  return
      "When the \"Replay Buffer\" is saved, "
      .. "then the selected media source is updated with the latest replay as soon as the replay is ready. "
      .. "Requires an active replay buffer."
      .. "\n\n"
      .. "Made by cimnine based on previous work by Lain and Exeldro."
end

-- A function named script_properties defines the properties that the user
-- can change for the entire script module itself
function script_properties()
  local props = obs.obs_properties_create()

  local p_media_source = obs.obs_properties_add_list(props, "source", "Media Source", obs.OBS_COMBO_TYPE_EDITABLE,
    obs.OBS_COMBO_FORMAT_STRING)
  local sources = obs.obs_enum_sources()
  if sources ~= nil then
    for _, source in ipairs(sources) do
      local source_id = obs.obs_source_get_id(source)
      if source_id == "ffmpeg_source" then
        local name = obs.obs_source_get_name(source)
        obs.obs_property_list_add_string(p_media_source, name, name)
      elseif source_id == "vlc_source" then
        local name = obs.obs_source_get_name(source)
        obs.obs_property_list_add_string(p_media_source, name, name)
      else
        logger(obs.LOG_DEBUG, "Ignoring source_id '" .. source_id .. "'")
      end
    end
  end
  obs.source_list_release(sources)

  local p_delay = obs.obs_properties_add_int(props, "load_delay", "Media Source Update Delay", 50, 5000, 100)
  obs.obs_property_int_set_suffix(p_delay, "ms")
  local p_attempts = obs.obs_properties_add_int(props, "max_attempts",
    "Number of Attempts to Update Media Source",
    0, 60, 1)

  local p_loglevel = obs.obs_properties_add_list(props, "log_level", "Log Level",
    obs.OBS_COMBO_TYPE_LIST, obs.OBS_COMBO_FORMAT_INT)
  obs.obs_property_list_add_int(p_loglevel, "Errors", obs.LOG_ERROR)
  obs.obs_property_list_add_int(p_loglevel, "Warning", obs.LOG_WARNING)
  obs.obs_property_list_add_int(p_loglevel, "Info", obs.LOG_INFO)
  obs.obs_property_list_add_int(p_loglevel, "Debug", obs.LOG_DEBUG)

  return props
end

-- A function named script_load will be called on startup
function script_load(settings)
  obs.obs_frontend_add_event_callback(frontend_event_cb)
end
