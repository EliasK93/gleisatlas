"""The response models of the API: the public (German) contract."""

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field


class Stats(BaseModel):
    n: int  # stops including cancellations
    ausfallquote: float
    median: float | None  # minutes, non-cancelled stops only
    p90: float | None
    puenktlich: float | None  # share below 6 minutes


class Day(Stats):
    weekday: int  # 0 = Monday


class Cell(Day):
    hour: int


class Heatmap(BaseModel):
    von: str
    bis: str
    n: int
    cells: list[Cell]
    tage: list[Day]  # same statistics per weekday over all hours
    titel: str | None = None  # the line label for a line's heatmap; None otherwise


class Station(BaseModel):
    eva: str
    name: str
    land: str | None  # code of the federal state ('nw', ...); None where not known
    n: int  # stops over the whole data set, all categories


class SuchLinie(BaseModel):
    linie: str
    label: str
    typ: str
    zug: bool  # a single train number ("ICE 679"), not a line
    richtung: Literal[1, 2] | None  # the line page's direction toward the end station searched for
    ziel: str | None  # that end station's name; set exactly when richtung is


class Suche(BaseModel):
    bahnhoefe: list[Station]
    linien: list[SuchLinie]
    zuerst: Literal["bahnhoefe", "linien"]  # the group to list first


class KartenStation(Stats):
    eva: str
    name: str
    lat: float
    lon: float


class Karte(BaseModel):
    von: str
    bis: str
    n: int  # all stops in the selection, also at stations that are not listed
    ohne_koordinaten: int  # named stations with stops in the selection but no coordinates
    stationen: list[KartenStation]


class Normal(BaseModel):
    """The median of a metric over the reference days; None with fewer than 8 valid days."""

    puenktlich: float | None
    ausfallquote: float | None
    median: float | None
    p90: float | None


class Klasse(BaseModel):
    """How far a day is from its normal (a station's, a state's or Germany's), in the usual
    variation of its reference days: 1 (much better), 2, 3 (as usual), 4, 5 (much worse).
    None without a shown value or a normal."""

    puenktlich: int | None
    ausfallquote: int | None
    median: int | None
    p90: int | None


class TageskartenStation(KartenStation):
    land: str | None  # code of the federal state ('be', 'by', ...); None where not known
    normal: Normal
    klasse: Klasse
    live: bool = False  # today only: the values come from the collector, not from the raw data


class Deutschland(Stats):
    normal: Normal
    klasse: Klasse


class Land(BaseModel):
    """A federal state, valued like Germany from the large stations that feed Germany's value."""

    land: str  # code, as in TageskartenStation.land
    bahnhoefe: int  # distinct station names among those with stops that day
    alle: Deutschland
    fern: Deutschland | None
    regional: Deutschland | None


class Tageskarte(BaseModel):
    tag: str  # 'YYYY-MM-DD', the planned arrival day
    referenztage: list[str]  # the days the normal rests on, nearest first
    fehlende_stunden: int  # hours of the day with incomplete data
    deutschland: Deutschland | None  # all trains; None when the large stations have no stops
    deutschland_fern: Deutschland | None  # the same for fern stops only; None without any
    deutschland_regional: Deutschland | None  # ... and for regional stops only
    n: int  # = deutschland.n: stops at the large stations, today those at the reporting ones
    laender: list[Land]  # by code; only states with stops that day
    ohne_koordinaten: int  # named stations with stops that day but no coordinates
    # large stations only; today: all of them, n = 0 without data
    stationen: list[TageskartenStation]
    stand: str | None = None  # today: the collector's run time, ISO UTC; None without live data
    bis_stunde: int | None = None  # arrivals planned before this local hour count (live stations)
    stand_rest: str | None = None  # today: the raw data's newest snapshot; None without it
    bis_stunde_rest: int | None = None  # the same cut for the stations from the raw data
    deutschland_live: bool | None = None  # today: the card uses live (True) or rest stations


class Gruppe(Stats):
    gruppe: str  # 'regional' or 'fern'


class Statistik(BaseModel):
    station: Station
    von: str
    bis: str
    n: int
    gesamt: Stats | None
    verteilung: list[int] = Field(
        description="Non-cancelled stops per delay bin in whole minutes, 7 values: "
        "< 1 (early included), [1, 3), [3, 6), [6, 10), [10, 20), [20, 30), >= 30. "
        "Empty when n is 0."
    )
    ausgefallen: int  # cancelled stops; verteilung plus ausgefallen sums to n
    gruppen: list[Gruppe]  # only groups with stops


class RanglistenEintrag(Stats):
    id: str  # EVA of a station, `linie` key of a line
    name: str  # station name or line label
    typ: str | None  # train type of a line; None for stations


class Rangliste(BaseModel):
    typ: Literal["linien", "bahnhoefe"]
    metrik: Literal["puenktlich", "median", "p90", "ausfallquote"]
    min_n: int
    von: str
    bis: str
    anzahl: int  # entries that meet min_n and have a value for the metric
    schlechteste: list[RanglistenEintrag]  # worst first, at most `limit` (default 10)
    beste: list[RanglistenEintrag]  # best first, at most `limit`


class AbschnittLinie(BaseModel):
    id: str  # `linie` key
    label: str
    n: int  # trips of the line through the section
    # the line page's direction in which the section is a row of the route; None for a section off
    # the line's axis (a branch, a skipped stop): the page cannot select it
    richtung: Literal[1, 2] | None


class RanglistenAbschnitt(BaseModel):
    von_eva: str
    von_name: str
    nach_eva: str
    nach_name: str
    n: int  # trips over the section in the period, all lines
    minuten: float  # mean change of the delay over the section; negative: minutes made up
    linien_anzahl: int
    linien: list[AbschnittLinie]  # the three busiest, ties by id


class AbschnittsRangliste(BaseModel):
    min_n: int
    von: str
    bis: str
    anzahl: int  # sections that meet min_n
    schlechteste: list[RanglistenAbschnitt]  # most minutes lost first, at most `limit` (default 10)
    beste: list[RanglistenAbschnitt]  # most minutes made up first, at most `limit`


class RekordEintrag(BaseModel):
    id: str  # EVA of a station, `linie` key of a line
    name: str  # station name or line label
    wert: float  # stops per day (halte) or trips per hour of service (takt), 2 decimals
    n: int  # stops it rests on, cancelled included: a station's all, a line's arrivals


class Rekorde(BaseModel):
    art: Literal["halte", "takt"]
    min_n: int
    von: str
    bis: str
    anzahl: int  # entries that meet min_n
    meiste: list[RekordEintrag]  # highest value first, at most `limit` (default 10)
    wenigste: list[RekordEintrag]  # lowest value first, at most `limit`


class StationLinie(Stats):
    linie: str
    name: str  # line label
    typ: str


class LinienBahnhof(BaseModel):
    eva: str
    name: str
    lat: float | None
    lon: float | None
    pos: int | None  # first place on the line's axis, from 0; None off it (a branch)
    n: int  # 0 when the line has no stops there in the period: then all statistics are None
    ausfallquote: float | None
    median: float | None
    p90: float | None
    puenktlich: float | None


class Linie(BaseModel):
    linie: str
    name: str
    label: str
    typ: str
    zug: bool  # a single train number ("ICE 679"), not a line
    ohne_echtzeit: bool  # almost all stops at exactly 0 minutes: the line has no live data
    gesamt: Stats | None  # all the line's stations pooled for the period; None without stops
    achse: list[str]  # EVAs of the axis in order; a station may repeat (ring, reversal)
    bahnhoefe: list[LinienBahnhof]  # axis stations by first position, then the others by stops
    fahrplan_von: date | None  # first and last day of the line's trips; None without any
    fahrplan_bis: date | None


class Abschnitt(BaseModel):
    von_eva: str
    nach_eva: str
    n: int  # trips over the section in the period
    minuten: float  # mean change of the delay over the section; negative: minutes made up


class Halt(BaseModel):
    """Minutes since local midnight of the Fahrplan's day (beyond 1440 past midnight), None where
    the time is missing. `ist` is the change time, else the planned time; None when cancelled."""

    eva: str
    an_plan: int | None
    an_ist: int | None
    ab_plan: int | None
    ab_ist: int | None
    ausfall_an: bool
    ausfall_ab: bool


class Fahrt(BaseModel):
    zug: str  # "RE 10423"
    halte: list[Halt]  # in stop order


class Fahrplan(BaseModel):
    tag: str  # 'YYYY-MM-DD', the day the trips start
    fahrten: list[Fahrt]  # by the departure of their first stop


class Monat(BaseModel):
    monat: str  # 'YYYY-MM'
    n: int  # 0 when the selection has no stops in the month: then all statistics are None
    ausfallquote: float | None
    median: float | None
    p90: float | None
    puenktlich: float | None


class Zeitverlauf(BaseModel):
    titel: str | None  # station name or line label; None nationwide
    monate: list[Monat]  # every month of the data, ascending


class Trend(BaseModel):
    """Centred 28-day rolling median of the daily values; None with fewer than 14 values."""

    puenktlich: float | None
    ausfallquote: float | None
    median: float | None
    p90: float | None


class Tag(BaseModel):
    tag: str  # 'YYYY-MM-DD', the planned arrival day
    n: int  # 0 when the selection has no stops that day: then all statistics are None
    ausfallquote: float | None
    median: float | None
    p90: float | None
    puenktlich: float | None
    fehlende_stunden: int  # hours of the day with incomplete data
    trend: Trend


class Tagesverlauf(BaseModel):
    titel: str | None  # station name; None nationwide
    tage: list[Tag]  # every calendar day of the data, ascending


class Datenstand(BaseModel):
    monate: list[str]  # 'YYYY-MM'
    bahnhoefe: int  # named stations
    vollabdeckung_ab: str  # first month with at least half the stations of the largest month
    fehlende_stunden: dict[str, int]  # month -> hours with incomplete data; only months with gaps
    fahrplanwechsel: list[str]  # ISO dates of the timetable changes inside the data range
    erster_tag: str  # ISO dates of the first and last calendar day of the data
    letzter_tag: str
    fehlende_stunden_tage: dict[str, int]  # day -> hours with incomplete data; only days with gaps
    heute: str | None  # ISO day of today (live or rest data) after letzter_tag; None without
    heute_stand: str | None  # the collector's run time (large stations) for `heute`, ISO UTC
    heute_stand_rest: str | None  # the newest raw-data snapshot (the other stations), ISO UTC
    # ISO days the collector kept after letzter_tag and before today (Europe/Berlin), ascending:
    # /tageskarte serves them like complete days
    live_tage: list[str]
