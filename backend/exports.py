"""Exact MIDI seconds and high-resolution MusicXML, including overlaps and ties."""
import io
import math
import xml.etree.ElementTree as ET

import pretty_midi

DIVISIONS = 10080


def tag(parent, name, text=None, **attrs):
    child = ET.SubElement(parent, name, attrs)
    if text is not None:
        child.text = str(text)
    return child


def musicxml(p):
    # Duration is authoritative. Omit the optional engraved note-type: unquantized
    # humming has arbitrary durations, not just conventional note values/tuplets.
    scale = p["bpm"] / 60 * DIVISIONS
    events, ends = [], []
    for n in sorted(p["notes"], key=lambda n: (n["start"], n["pitch"])):
        start = round(n["start"] * scale)
        end = max(start + 1, round(n["end"] * scale))
        voice = next((i for i, last in enumerate(ends) if last <= start), len(ends))
        if voice == len(ends):
            ends.append(end)
        else:
            ends[voice] = end
        events.append({**n, "a": start, "b": end, "voice": voice + 1})
    root = ET.Element("score-partwise", version="4.0")
    tag(tag(root, "work"), "work-title", p["name"])
    tag(tag(root, "identification"), "creator", "Human-reviewed original melody", type="composer")
    score_part = tag(tag(root, "part-list"), "score-part", id="P1")
    tag(score_part, "part-name", "Master melody")
    part = tag(root, "part", id="P1")
    bar = 4 * DIVISIONS
    count = max(1, math.ceil(max((n["b"] for n in events), default=0) / bar))
    spellings = [('C', 0), ('C', 1), ('D', 0), ('D', 1), ('E', 0), ('F', 0),
                 ('F', 1), ('G', 0), ('G', 1), ('A', 0), ('A', 1), ('B', 0)]
    for index in range(count):
        measure = tag(part, "measure", number=str(index + 1))
        if index == 0:
            attrs = tag(measure, "attributes")
            tag(attrs, "divisions", DIVISIONS)
            time = tag(attrs, "time")
            tag(time, "beats", 4)
            tag(time, "beat-type", 4)
            clef = tag(attrs, "clef")
            tag(clef, "sign", "G")
            tag(clef, "line", 2)
            direction = tag(measure, "direction", placement="above")
            metronome = tag(tag(direction, "direction-type"), "metronome")
            tag(metronome, "beat-unit", "quarter")
            tag(metronome, "per-minute", p["bpm"])
            tag(direction, "sound", tempo=str(p["bpm"]))
        # A shared cursor moves backward for overlapping voices. Only active notes
        # are emitted so sparse polyphony does not multiply the measure count.
        cursor = 0
        left, right = index * bar, (index + 1) * bar
        for n in events:
            if n["b"] <= left or n["a"] >= right:
                continue
            start, end = max(n["a"], left) - left, min(n["b"], right) - left
            if start != cursor:
                tag(tag(measure, "forward" if start > cursor else "backup"), "duration", abs(start - cursor))
            item = tag(measure, "note")
            pitch = tag(item, "pitch")
            step, alter = spellings[n["pitch"] % 12]
            tag(pitch, "step", step)
            if alter:
                tag(pitch, "alter", alter)
            tag(pitch, "octave", n["pitch"] // 12 - 1)
            tag(item, "duration", end - start)
            ties = (["stop"] if n["a"] < left else []) + (["start"] if n["b"] > right else [])
            for tie in ties:
                tag(item, "tie", type=tie)
            tag(item, "voice", n["voice"])
            if ties:
                notations = tag(item, "notations")
                for tie in ties:
                    tag(notations, "tied", type=tie)
            cursor = end
        if cursor < bar:
            tag(tag(measure, "forward"), "duration", bar - cursor)
    ET.indent(root)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def render(p):
    midi = pretty_midi.PrettyMIDI(initial_tempo=p["bpm"], resolution=9600)
    instrument = pretty_midi.Instrument(0, name="Confirmed master melody")
    for n in sorted(p["notes"], key=lambda n: (n["start"], n["pitch"])):
        instrument.notes.append(pretty_midi.Note(n["velocity"], n["pitch"], n["start"], n["end"]))
    midi.instruments.append(instrument)
    buf = io.BytesIO()
    midi.write(buf)
    return {"master_melody.mid": buf.getvalue(), "master_melody.musicxml": musicxml(p)}
